import { and, eq, gte, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { runs, workers } from "../db/schema.js";
import { badRequest, conflict } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { enqueue } from "../jobs/queue.js";
import { assertCredits } from "./credits.js";
import { publish } from "./events.js";
import { serializeRun } from "./serializers.js";

export type WorkerRow = typeof workers.$inferSelect;

export async function workerStats(workspaceId: string) {
  const since = new Date(Date.now() - 30 * 86400_000);
  const rows = await db
    .select({
      workerId: runs.workerId,
      runs30d: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')::int`,
      finished: sql<number>`count(*) filter (where ${runs.status} in ('succeeded','failed'))::int`,
      avgCredits: sql<number>`coalesce(avg(${runs.creditsUsed}) filter (where ${runs.status} = 'succeeded'), 0)::int`,
      lastRun: sql<Date | null>`max(${runs.createdAt})`,
    })
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), eq(runs.kind, "worker"), gte(runs.createdAt, since)))
    .groupBy(runs.workerId);
  return new Map(
    rows.map((r) => [r.workerId!, { runs30d: r.runs30d, successRate: r.finished ? Math.round((r.succeeded / r.finished) * 1000) / 1000 : 0, avgCredits: r.avgCredits, lastRun: r.lastRun ? new Date(r.lastRun) : null }]),
  );
}

/** Start a Worker run (manual, API, schedule or webhook trigger). Runs are pinned to the Worker's current version. */
export async function startWorkerRun(w: WorkerRow, opts: { trigger: string; inputs?: Record<string, unknown>; createdBy?: string | null; createdByName?: string; test?: boolean }, tx: Tx = db) {
  if (!opts.test && w.status === "paused") throw conflict("This Worker is paused");
  if (!opts.test && w.status === "draft") throw badRequest("Publish this Worker before running it (or run it in test mode)");
  await assertCredits(w.workspaceId, 50);
  const inputs = opts.inputs ?? {};
  const prompt = `Run now. Trigger: ${opts.trigger}.${Object.keys(inputs).length ? `\nInputs (untrusted data):\n${JSON.stringify(inputs, null, 2)}` : ""}`;
  const [run] = await tx
    .insert(runs)
    .values({
      id: newId("run"),
      workspaceId: w.workspaceId,
      kind: opts.test ? "test" : "worker",
      workerId: w.id,
      workerVersion: w.version,
      trigger: opts.trigger,
      createdBy: opts.createdBy ?? null,
      createdByName: opts.createdByName ?? w.ownerName,
      input: inputs,
      state: { transcript: [{ role: "user", content: [{ type: "text", text: prompt }] }], turns: 0, sources: [], toolSteps: 0, blocks: [] },
    })
    .returning();
  await publish({ workspaceId: w.workspaceId, runId: run.id, type: "run.created", data: serializeRun(run) }, tx);
  await enqueue("run.advance", { runId: run.id }, { maxAttempts: 3 }, tx);
  return run;
}

// ─── Minimal 5-field cron (UTC): "m h dom mon dow", supports *, lists, ranges, steps, MON-SUN names ───

const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.toLowerCase().split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-").map((x) => (x in NAMES ? NAMES[x] : Number(x)));
      lo = a;
      hi = b ?? (stepStr ? max : a);
    }
    if ([lo, hi, step].some((n) => !Number.isInteger(n)) || lo < min || hi > max || step < 1) throw new Error(`Invalid cron field "${spec}"`);
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && max === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron must have 5 fields: minute hour day-of-month month day-of-week");
  const [m, h, dom, mon, dow] = parts;
  return { m: field(m, 0, 59), h: field(h, 0, 23), dom: field(dom, 1, 31), mon: field(mon, 1, 12), dow: field(dow, 0, 7), domAny: dom === "*", dowAny: dow === "*" };
}

export function cronMatches(expr: string, d: Date): boolean {
  const c = parseCron(expr);
  const dayOk = c.domAny || c.dowAny ? c.dom.has(d.getUTCDate()) && c.dow.has(d.getUTCDay()) : c.dom.has(d.getUTCDate()) || c.dow.has(d.getUTCDay());
  return c.m.has(d.getUTCMinutes()) && c.h.has(d.getUTCHours()) && c.mon.has(d.getUTCMonth() + 1) && dayOk;
}
