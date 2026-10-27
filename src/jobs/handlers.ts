import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client.js";
import { approvals, events, jobs, workers } from "../db/schema.js";
import { advanceRun } from "../runtime/agent.js";
import { runWorkerEvals } from "../runtime/evals.js";
import { publish } from "../services/events.js";
import { serializeApproval } from "../services/serializers.js";
import { deliverWebhook } from "../services/webhooks.js";
import { cronMatches, startWorkerRun } from "../services/workers.js";
import { enqueue, registerJob } from "./queue.js";

export function registerJobHandlers() {
  registerJob("run.advance", (p, { log }) => advanceRun(String(p.runId), log));
  registerJob("webhook.deliver", (p) => deliverWebhook(String(p.deliveryId)));
  registerJob("evals.run", (p) => runWorkerEvals(String(p.workspaceId), String(p.workerId)));
}

/**
 * Once a minute, on every worker instance: fire due schedules (exactly once per minute thanks to
 * the conditional `last_scheduled_at` update), expire stale approvals and prune old data.
 */
export async function schedulerTick(log: FastifyBaseLogger, now = new Date()) {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const candidates = await db.select().from(workers).where(and(isNotNull(workers.schedule), inArray(workers.status, ["live", "canary"])));
  for (const w of candidates) {
    try {
      if (!cronMatches(w.schedule!, minute)) continue;
      const [claimed] = await db
        .update(workers)
        .set({ lastScheduledAt: minute })
        .where(and(eq(workers.id, w.id), or(isNull(workers.lastScheduledAt), lt(workers.lastScheduledAt, minute))))
        .returning();
      if (claimed) await startWorkerRun(claimed, { trigger: `Schedule (${w.schedule})` });
    } catch (err) {
      log.warn({ err, workerId: w.id }, "scheduled run failed to start");
    }
  }

  const expired = await db.update(approvals).set({ status: "expired" }).where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now))).returning();
  for (const a of expired) {
    await publish({ workspaceId: a.workspaceId, threadId: a.threadId, runId: a.runId, type: "approval.updated", data: serializeApproval(a) });
    if (a.runId) await enqueue("run.advance", { runId: a.runId });
  }

  if (now.getUTCMinutes() === 0) {
    await db.delete(events).where(lt(events.createdAt, new Date(now.getTime() - 3 * 86400_000)));
    await db.delete(jobs).where(and(inArray(jobs.status, ["done"]), lt(jobs.createdAt, new Date(now.getTime() - 7 * 86400_000))));
  }
}
