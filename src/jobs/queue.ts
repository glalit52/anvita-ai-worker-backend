import { hostname } from "node:os";
import { and, eq, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { db, sqlClient, type Tx } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { randomString } from "../lib/ids.js";

/**
 * Durable Postgres-backed job queue (FOR UPDATE SKIP LOCKED). Agent runs, resumes, webhook
 * deliveries and scheduled worker runs all go through it, so any instance can pick work up and
 * nothing is lost on restart. The JobHandler contract is narrow enough to swap in Temporal later
 * (docs/technical-architecture.md ADR 1) without touching callers.
 */

export type JobHandler = (payload: Record<string, unknown>, ctx: { jobId: number; attempt: number; log: FastifyBaseLogger }) => Promise<void>;

const CHANNEL = "anvita_jobs";
const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export interface EnqueueOpts { runAt?: Date; delayMs?: number; maxAttempts?: number; dedupeKey?: string }

export async function enqueue(type: string, payload: Record<string, unknown>, opts: EnqueueOpts = {}, tx: Tx = db): Promise<void> {
  const runAt = opts.runAt ?? new Date(Date.now() + (opts.delayMs ?? 0));
  await tx
    .insert(jobs)
    .values({ type, payload, runAt, maxAttempts: opts.maxAttempts ?? 5, dedupeKey: opts.dedupeKey ?? null })
    .onConflictDoNothing();
  await tx.execute(sql`select pg_notify(${CHANNEL}, ${type})`);
}

const STALE_LOCK_MS = 15 * 60_000;

export class JobRunner {
  private readonly id = `${hostname()}-${process.pid}-${randomString(4)}`;
  private running = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private inflight = new Set<Promise<void>>();
  private unlisten: (() => Promise<void>) | null = null;

  constructor(private readonly log: FastifyBaseLogger, private readonly concurrency = config.JOBS_CONCURRENCY) {}

  async start() {
    const sub = await sqlClient.listen(CHANNEL, () => this.tick());
    this.unlisten = sub.unlisten;
    this.loop();
    this.log.info({ worker: this.id, concurrency: this.concurrency }, "job runner started");
  }

  private loop() {
    if (this.stopped) return;
    void this.tick();
    this.timer = setTimeout(() => this.loop(), config.JOBS_POLL_MS);
  }

  /** Claim as many ready jobs as we have free slots. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const free = this.concurrency - this.running;
    if (free <= 0) return;
    this.running += free; // reserve slots while claiming to avoid over-claiming on concurrent ticks
    let claimed: (typeof jobs.$inferSelect)[] = [];
    try {
      await db
        .update(jobs)
        .set({ status: "queued", lockedAt: null, lockedBy: null })
        .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, new Date(Date.now() - STALE_LOCK_MS))));
      claimed = (await db.execute(sql`
        update jobs set status = 'running', locked_at = now(), locked_by = ${this.id}, attempts = attempts + 1
        where id in (
          select id from jobs where status = 'queued' and run_at <= now()
          order by run_at, id limit ${free} for update skip locked
        ) returning id, type, payload, attempts, max_attempts as "maxAttempts"`)) as unknown as (typeof jobs.$inferSelect)[];
    } catch (err) {
      this.log.error({ err }, "failed to claim jobs");
    } finally {
      this.running -= free - claimed.length;
    }
    for (const job of claimed) {
      const p = this.execute(job).finally(() => {
        this.running--;
        this.inflight.delete(p);
        if (!this.stopped) void this.tick();
      });
      this.inflight.add(p);
    }
  }

  private async execute(job: Pick<typeof jobs.$inferSelect, "id" | "type" | "payload" | "attempts" | "maxAttempts">) {
    const log = this.log.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new Error(`no handler registered for job type ${job.type}`);
      await handler(job.payload, { jobId: job.id, attempt: job.attempts, log });
      await db.update(jobs).set({ status: "done", lockedAt: null, lockedBy: null }).where(eq(jobs.id, job.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const final = job.attempts >= job.maxAttempts;
      log[final ? "error" : "warn"]({ err }, final ? "job failed permanently" : "job failed, will retry");
      const backoffMs = Math.min(10 * 60_000, 2 ** job.attempts * 1000);
      await db
        .update(jobs)
        .set({ status: final ? "failed" : "queued", lastError: msg.slice(0, 2000), lockedAt: null, lockedBy: null, runAt: new Date(Date.now() + backoffMs) })
        .where(eq(jobs.id, job.id));
    }
  }

  /** Stop claiming, then wait for in-flight jobs (bounded) so deploys don't cut runs mid-step. */
  async stop(timeoutMs = 25_000) {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.unlisten?.();
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** Test helper: run until the queue has no ready jobs. */
  async drain(maxRounds = 200) {
    for (let i = 0; i < maxRounds; i++) {
      await this.tick();
      await Promise.allSettled([...this.inflight]);
      const [row] = (await db.execute(sql`select count(*)::int as n from jobs where status in ('queued','running') and run_at <= now()`)) as unknown as { n: number }[];
      if (!row || row.n === 0) return;
    }
  }
}
