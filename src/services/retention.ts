import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { artifacts, inboxConversations, runs, runSteps, threads, workspaces } from "../db/schema.js";
import { audit } from "./audit.js";
import { policyFrom } from "./security.js";

/**
 * Conversation retention (Settings → Security): content older than the workspace's limit is
 * deleted — chats and their messages, files, run inputs/transcripts and step logs, resolved
 * inbox transcripts. Audit events and run metadata (who ran what, credits) are kept.
 */
export async function applyRetention(now = new Date()) {
  const rows = await db.select({ id: workspaces.id, settings: workspaces.settings }).from(workspaces);
  const out: { workspaceId: string; threads: number; artifacts: number; runs: number }[] = [];
  for (const w of rows) {
    const days = policyFrom(w.settings as Record<string, unknown>).retentionDays;
    if (!days) continue;
    const cutoff = new Date(now.getTime() - days * 86400_000);
    const deletedThreads = await db.delete(threads).where(and(eq(threads.workspaceId, w.id), lt(threads.updatedAt, cutoff))).returning({ id: threads.id });
    const deletedArtifacts = await db.delete(artifacts).where(and(eq(artifacts.workspaceId, w.id), lt(artifacts.createdAt, cutoff))).returning({ id: artifacts.id });
    const oldRuns = await db
      .update(runs)
      .set({ input: {}, state: {} })
      .where(and(eq(runs.workspaceId, w.id), lt(runs.createdAt, cutoff), inArray(runs.status, ["succeeded", "failed", "cancelled"]), sql`${runs.state} <> '{}'::jsonb`))
      .returning({ id: runs.id });
    if (oldRuns.length) await db.delete(runSteps).where(inArray(runSteps.runId, oldRuns.map((r) => r.id)));
    await db.update(inboxConversations).set({ transcript: [], summary: "" }).where(and(eq(inboxConversations.workspaceId, w.id), eq(inboxConversations.status, "resolved"), lt(inboxConversations.updatedAt, cutoff)));
    if (deletedThreads.length || deletedArtifacts.length || oldRuns.length) {
      await audit({ workspaceId: w.id, actor: "Retention policy", actorType: "system", action: "data.retention", target: `${deletedThreads.length} chats, ${deletedArtifacts.length} files, ${oldRuns.length} run logs older than ${days} days`, channel: "System" });
    }
    out.push({ workspaceId: w.id, threads: deletedThreads.length, artifacts: deletedArtifacts.length, runs: oldRuns.length });
  }
  return out;
}
