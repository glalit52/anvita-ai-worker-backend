import { and, eq, sql } from "drizzle-orm";
import { appById, SYSTEM_APPS } from "../catalog/index.js";
import { parseCredentials } from "../connectors/index.js";
import { db } from "../db/client.js";
import { approvals, connections, runs, runSteps, workers, workspaces } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { audit } from "../services/audit.js";
import { charge } from "../services/credits.js";
import { publish } from "../services/events.js";
import { notify } from "../services/notifications.js";
import { approverRole } from "../services/rbac.js";
import { serializeApproval } from "../services/serializers.js";
import { emitWebhook } from "../services/webhooks.js";
import { evaluatePolicies, type Decision } from "./policy.js";
import type { ApprovalPreview, ToolContext, ToolDef, ToolResult } from "./tools/types.js";

/**
 * Tool gateway: the one path every tool call takes — from the agent loop, workflow steps and
 * sandboxed code alike. Checks the app connection, evaluates workspace policy (deny / approve /
 * allow), executes, charges credits, records the run step and writes the audit trail.
 */

export type Run = typeof runs.$inferSelect;

export const appName = (id: string) => appById[id]?.name ?? id;

export async function runActor(run: Run): Promise<ToolContext["actor"]> {
  if (run.kind === "agent" && !run.workerId) return { type: "agent", name: "Anvita" };
  const [w] = await db.select({ name: workers.name }).from(workers).where(eq(workers.id, run.workerId ?? ""));
  return { type: "worker", name: w?.name ?? "Worker" };
}

/** The app's healthy connection with decrypted credentials, `null` for system apps, or "missing". */
export async function resolveConnection(run: Run, tool: ToolDef): Promise<ToolContext["connection"] | "missing"> {
  if (!tool.needsConnection || SYSTEM_APPS.has(tool.appId)) return null;
  const [conn] = await db.select().from(connections).where(and(eq(connections.workspaceId, run.workspaceId), eq(connections.appId, tool.appId)));
  if (!conn || conn.status !== "healthy") return "missing";
  await db.update(connections).set({ actionsUsed30d: sql`${connections.actionsUsed30d} + 1` }).where(eq(connections.id, conn.id));
  const creds = parseCredentials(conn.credentialsEnc);
  return creds ? { id: conn.id, credentials: creds } : null;
}

export async function toolContext(run: Run, connection: ToolContext["connection"]): Promise<ToolContext> {
  const [ws] = await db.select({ domains: workspaces.domains }).from(workspaces).where(eq(workspaces.id, run.workspaceId));
  return { workspaceId: run.workspaceId, runId: run.id, threadId: run.threadId, actor: await runActor(run), onBehalfOf: { userId: run.createdBy, name: run.createdByName ?? "—" }, workspaceDomains: ws?.domains ?? [], connection };
}

export type PolicyOutcome =
  | { kind: "proceed"; input: Record<string, unknown> }
  | { kind: "denied"; reason: string }
  | { kind: "declined"; status: "rejected" | "expired"; by: string | null }
  | { kind: "waiting"; approvalId: string; created: boolean };

/**
 * Policy and approval for one call, keyed by `callId` (the model's tool_use id, or a workflow
 * step id) so a resumed run finds the approval it created before.
 */
export async function policyGate(run: Run, tool: ToolDef, input: Record<string, unknown>, ctx: ToolContext, callId: string, opts: { requireApproval?: boolean; approvalOverride?: { title?: string; approvers?: string; timeoutMs?: number; reason?: string } } = {}): Promise<PolicyOutcome> {
  if (tool.sideEffect === "none" && !opts.requireApproval) return { kind: "proceed", input };
  const [existing] = await db.select().from(approvals).where(and(eq(approvals.runId, run.id), eq(approvals.toolUseId, callId)));
  if (existing) {
    if (existing.status === "pending") return { kind: "waiting", approvalId: existing.id, created: false };
    if (existing.status !== "approved") return { kind: "declined", status: existing.status as "rejected" | "expired", by: existing.decidedBy };
    return { kind: "proceed", input: existing.payload as Record<string, unknown> }; // may contain human edits
  }
  const facts = { action: tool.action, app: tool.appId, actor: ctx.actor.type, side_effect: tool.sideEffect, ...(tool.facts?.(input, ctx) ?? {}) };
  const decision: Decision = tool.sideEffect === "none" ? { effect: "allow", reason: "" } : await evaluatePolicies(run.workspaceId, tool.action, tool.sideEffect, facts);
  if (decision.effect === "deny") {
    await audit({ workspaceId: run.workspaceId, actor: ctx.actor.name, actorType: ctx.actor.type, action: "policy.denied", target: `${tool.action} · ${decision.policyName ?? "default"}`, payload: { runId: run.id } });
    return { kind: "denied", reason: decision.reason };
  }
  if (decision.effect === "approve" || opts.requireApproval) {
    const a = tool.approval?.(input, ctx) ?? defaultApproval(tool, input);
    const row = await createApproval(run, ctx, {
      callId,
      title: opts.approvalOverride?.title ?? a.title,
      action: tool.action,
      appId: tool.appId,
      reason: opts.approvalOverride?.reason ?? (decision.effect === "approve" ? decision.reason : "Workflow step requires review"),
      risk: a.risk,
      preview: a.preview,
      payload: input,
      policyId: decision.policyId ?? null,
      approvers: opts.approvalOverride?.approvers ?? decision.approvers ?? "Owner",
      timeoutMs: opts.approvalOverride?.timeoutMs,
    });
    return { kind: "waiting", approvalId: row.id, created: true };
  }
  return { kind: "proceed", input };
}

export function defaultApproval(tool: Pick<ToolDef, "action" | "label">, input: Record<string, unknown>): { title: string; risk: "low" | "medium" | "high"; preview: ApprovalPreview } {
  return { title: tool.label(input), risk: "medium", preview: { kind: "fields", record: tool.action, changes: Object.entries(input).map(([k, v]) => ({ field: k, from: "—", to: typeof v === "string" ? v : JSON.stringify(v) })) } };
}

export async function createApproval(
  run: Run,
  ctx: ToolContext,
  a: { callId: string; title: string; action: string; appId: string; reason: string; risk: "low" | "medium" | "high"; preview: ApprovalPreview; payload: Record<string, unknown>; policyId?: string | null; approvers: string; timeoutMs?: number },
) {
  const [row] = await db
    .insert(approvals)
    .values({
      id: newId("apr"),
      workspaceId: run.workspaceId,
      runId: run.id,
      toolUseId: a.callId,
      threadId: run.threadId,
      title: a.title.slice(0, 200),
      action: a.action,
      appId: a.appId,
      requestedBy: ctx.actor,
      onBehalfOf: run.createdByName ?? "—",
      reason: a.reason,
      risk: a.risk,
      credits: 2,
      preview: a.preview,
      payload: a.payload,
      policyId: a.policyId ?? null,
      approverRole: approverRole(a.approvers),
      expiresAt: new Date(Date.now() + (a.timeoutMs ?? 24 * 3600_000)),
    })
    .returning();
  await publish({ workspaceId: run.workspaceId, threadId: run.threadId, runId: run.id, type: "approval.created", data: serializeApproval(row) });
  await notify({ workspaceId: run.workspaceId, appId: a.appId, title: `${a.title} needs your approval`, meta: `${ctx.actor.name} · just now`, href: "/approvals", minRole: row.approverRole ?? "member" });
  await emitWebhook(run.workspaceId, "approval.requested", serializeApproval(row));
  await audit({ workspaceId: run.workspaceId, actor: ctx.actor.name, actorType: ctx.actor.type, action: "approval.requested", target: `${a.action} · ${a.title}`, payload: { approvalId: row.id, runId: run.id } });
  return row;
}

export async function recordStep(run: Run, seq: number, s: { kind: string; name: string; label: string; appId?: string | null; status: string; input?: unknown; output?: unknown; model?: string; tokens?: unknown; credits?: number; startedAt?: Date }) {
  await db.insert(runSteps).values({ id: newId("stp"), runId: run.id, workspaceId: run.workspaceId, seq, kind: s.kind, name: s.name, label: s.label, appId: s.appId ?? null, status: s.status, input: (s.input ?? null) as object, output: (s.output ?? null) as object, model: s.model ?? null, tokens: (s.tokens ?? null) as object, credits: s.credits ?? 0, startedAt: s.startedAt ?? new Date(), endedAt: new Date() });
}

let stepSeq = 0;
/** Time-ordered sequence for steps recorded outside the agent loop's own counter. */
export function nextSeq() {
  stepSeq = (stepSeq + 1) % 100;
  return Date.now() * 100 + stepSeq;
}

/** Execute after the gate passed: charge, record the step and audit side effects. Throws on tool failure (after recording it). */
export async function executeTool(run: Run, tool: ToolDef, input: Record<string, unknown>, ctx: ToolContext, seq: number, channel?: string): Promise<ToolResult & { durationMs: number; credits: number }> {
  const started = Date.now();
  try {
    const res = await tool.execute(input, ctx);
    const credits = res.credits ?? 1;
    await charge(run.workspaceId, credits, { type: "run", id: run.id }, { tool: tool.action });
    await db.update(runs).set({ creditsUsed: sql`${runs.creditsUsed} + ${credits}`, stepsCount: sql`${runs.stepsCount} + 1` }).where(eq(runs.id, run.id));
    await recordStep(run, seq, { kind: tool.kind, name: tool.action, label: tool.label(input), appId: tool.appId, status: "done", input, output: res.output, credits, startedAt: new Date(started) });
    if (tool.sideEffect !== "none") await audit({ workspaceId: run.workspaceId, actor: ctx.actor.name, actorType: ctx.actor.type, action: tool.action, target: tool.label(input), channel: channel ?? (run.threadId ? "Web" : "Worker"), payload: { runId: run.id } });
    return { ...res, credits, durationMs: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordStep(run, seq, { kind: tool.kind, name: tool.action, label: tool.label(input), appId: tool.appId, status: "error", input, output: { error: msg }, startedAt: new Date(started) });
    throw e;
  }
}

/**
 * Non-pausing call (used by sandboxed code): reads and policy-allowed writes run immediately;
 * anything needing a connection or a human approval fails with an explanation instead of parking.
 */
export async function invokeImmediately(run: Run, tool: ToolDef, input: Record<string, unknown>): Promise<ToolResult> {
  const connection = await resolveConnection(run, tool);
  if (connection === "missing") throw new Error(`${appName(tool.appId)} isn't connected. Connect it on the Integrations page, then run this again.`);
  const ctx = await toolContext(run, connection);
  if (tool.sideEffect !== "none") {
    const facts = { action: tool.action, app: tool.appId, actor: ctx.actor.type, side_effect: tool.sideEffect, ...(tool.facts?.(input, ctx) ?? {}) };
    const decision = await evaluatePolicies(run.workspaceId, tool.action, tool.sideEffect, facts);
    if (decision.effect === "deny") throw new Error(`Blocked by workspace policy: ${decision.reason}`);
    if (decision.effect === "approve") throw new Error(`${tool.action} needs human approval (${decision.reason}). Code can't wait for approvals — do this in a Tool or Send step after the code step.`);
  }
  return executeTool(run, tool, input, ctx, nextSeq(), "Sandbox");
}
