import type * as C from "../contracts/web.js";
import type * as S from "../db/schema.js";

/**
 * DB rows → API shapes. Field names follow the web app contract (contracts/web.ts); timestamps are
 * ISO-8601 strings that the client formats ("2 min ago", "Mon 09:02").
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function serializeMessage(m: typeof S.messages.$inferSelect): C.ChatMessage & { threadId: string; runId: string | null; createdAt: string } {
  return { id: m.id, threadId: m.threadId, role: m.role, author: m.author, time: m.createdAt.toISOString(), createdAt: m.createdAt.toISOString(), blocks: m.blocks as C.ChatBlock[], streaming: m.streaming || undefined, runId: m.runId };
}

export function serializeThread(t: typeof S.threads.$inferSelect, msgs?: (typeof S.messages.$inferSelect)[]) {
  return {
    id: t.id,
    title: t.title,
    channel: t.channel,
    channelLabel: t.channelLabel ?? undefined,
    updatedAt: t.updatedAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    pinned: t.pinned,
    unread: t.unread,
    status: t.status,
    workerId: t.workerId,
    ...(msgs ? { messages: msgs.map(serializeMessage) } : {}),
  };
}

export function serializeRun(r: typeof S.runs.$inferSelect) {
  const durationMs = r.startedAt ? (r.endedAt ?? new Date()).getTime() - r.startedAt.getTime() : 0;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    threadId: r.threadId,
    workerId: r.workerId,
    workerVersion: r.workerVersion,
    trigger: r.trigger,
    createdBy: r.createdByName,
    estimateCredits: r.estimateCredits,
    credits: r.creditsUsed,
    steps: r.stepsCount,
    error: r.error,
    output: (r.state as { output?: string }).output ?? null,
    startedAt: iso(r.startedAt),
    endedAt: iso(r.endedAt),
    createdAt: r.createdAt.toISOString(),
    durationMs,
  };
}

export function serializeApproval(a: typeof S.approvals.$inferSelect): C.Approval & { runId: string | null; approverRole: string | null; decidedAt: string | null; expiresAt: string } {
  const msLeft = a.expiresAt.getTime() - Date.now();
  const h = Math.floor(msLeft / 3600_000);
  const m = Math.floor((msLeft % 3600_000) / 60_000);
  return {
    id: a.id,
    title: a.title,
    action: a.action,
    appId: a.appId,
    requestedBy: a.requestedBy,
    onBehalfOf: a.onBehalfOf,
    reason: a.reason,
    risk: a.risk,
    createdAt: a.createdAt.toISOString(),
    expiresIn: msLeft <= 0 ? "expired" : h > 0 ? `${h} h${m ? ` ${m} m` : ""}` : `${m} m`,
    expiresAt: a.expiresAt.toISOString(),
    status: a.status,
    credits: a.credits,
    preview: a.preview as C.Approval["preview"],
    threadId: a.threadId ?? undefined,
    decidedBy: a.decidedBy ?? undefined,
    decidedAt: iso(a.decidedAt),
    runId: a.runId,
    approverRole: a.approverRole,
  };
}

export function serializeMember(m: typeof S.memberships.$inferSelect): C.Member & { userId: string | null } {
  return { id: m.id, userId: m.userId, name: m.name, email: m.email, role: m.role, status: m.status, lastActive: m.lastActiveAt ? m.lastActiveAt.toISOString() : "—", sso: m.sso || undefined };
}

export function serializeConnection(c: typeof S.connections.$inferSelect): C.Connection & { id: string; hasCredentials: boolean; mode: "live" | "demo"; account: string | null; statusDetail: string | null } {
  return { id: c.id, appId: c.appId, scope: c.scope, connectedBy: c.connectedByName, connectedAt: c.createdAt.toISOString(), status: c.status, sharedWith: c.sharedWith.length ? c.sharedWith : undefined, actionsUsed30d: c.actionsUsed30d, hasCredentials: !!c.credentialsEnc, mode: c.mode, account: c.account, statusDetail: c.statusDetail };
}

export function serializeWorker(w: typeof S.workers.$inferSelect, stats?: { runs30d: number; successRate: number; avgCredits: number; lastRun: Date | null }): C.Worker & Record<string, unknown> {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    instructions: w.instructions,
    emoji: w.emoji,
    color: w.color,
    interaction: w.interaction,
    channels: w.channels,
    status: w.status,
    version: w.version,
    owner: w.ownerName,
    apps: w.apps,
    trigger: w.trigger,
    schedule: w.schedule,
    runs30d: stats?.runs30d ?? 0,
    successRate: stats?.successRate ?? 0,
    avgCredits: stats?.avgCredits ?? 0,
    // Estimated: each successful run saves ~12 minutes of manual work (configurable later per worker).
    hoursSaved30d: Math.round(((stats?.runs30d ?? 0) * (stats?.successRate ?? 0) * 12) / 60),
    lastRun: stats?.lastRun ? stats.lastRun.toISOString() : "—",
    createdFrom: w.createdFrom,
    pinned: w.pinned || undefined,
    nodes: w.nodes as C.WorkerNode[],
    edges: w.edges,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function serializeKb(kb: typeof S.knowledgeBases.$inferSelect, sources: (typeof S.kbSources.$inferSelect)[], counts: { docs: number; chunks: number }): C.KnowledgeBase {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    sources: sources.map((s) => ({ appId: s.appId, label: s.label, docs: 0, status: s.status, lastSync: s.lastSyncAt ? s.lastSyncAt.toISOString() : "never" })),
    docs: counts.docs,
    chunks: counts.chunks,
    usedBy: kb.usedBy,
    updatedAt: kb.updatedAt.toISOString(),
  };
}

export function serializeMemory(m: typeof S.memories.$inferSelect): C.MemoryItem {
  return { id: m.id, scope: m.scope, type: m.type, content: m.content, source: m.source, learnedAt: m.createdAt.toISOString(), uses: m.uses };
}

export function serializeSkill(s: typeof S.skills.$inferSelect): C.Skill & { stepsMd: string } {
  return { id: s.id, name: s.name, description: s.description, author: s.author, pack: s.pack ?? undefined, uses: s.uses, tools: s.tools, stepsMd: s.stepsMd };
}

export function serializePolicy(p: typeof S.policies.$inferSelect): C.Policy & { priority: number } {
  return { id: p.id, name: p.name, appliesTo: p.appliesTo, condition: p.condition, effect: p.effect, approvers: p.approvers ?? undefined, enabled: p.enabled, hits30d: p.hits30d, priority: p.priority };
}

export function serializeAudit(a: typeof S.auditEvents.$inferSelect): C.AuditEvent & { hash: string } {
  return { id: String(a.id), time: a.createdAt.toISOString(), actor: a.actor, actorType: a.actorType, action: a.action, target: a.target, channel: a.channel, ip: a.ip ?? undefined, hash: a.hash };
}

export function serializeApiKey(k: typeof S.apiKeys.$inferSelect): C.ApiKey {
  return { id: k.id, name: k.name, prefix: k.prefix, scope: k.scope, createdAt: k.createdAt.toISOString(), lastUsed: k.lastUsedAt ? k.lastUsedAt.toISOString() : "never", revoked: !!k.revokedAt || undefined };
}

export function serializeWebhook(w: typeof S.webhooks.$inferSelect): C.Webhook & { createdAt: string } {
  return { id: w.id, url: w.url, events: w.events, active: w.active, createdAt: w.createdAt.toISOString() };
}

export function serializeNotification(n: typeof S.notifications.$inferSelect): C.AppNotification & { createdAt: string } {
  return { id: n.id, appId: n.appId, title: n.title, meta: n.meta, href: n.href, read: n.read, createdAt: n.createdAt.toISOString() };
}

export function serializeMcp(s: typeof S.mcpServers.$inferSelect): C.McpServer & { enabled: boolean; toolNames: string[]; lastError: string | null; lastCheckedAt: string | null } {
  return { id: s.id, name: s.name, url: s.url, auth: s.auth, tools: s.tools, status: s.status, enabled: s.enabled, toolNames: s.toolDefs.map((t) => t.name), lastError: s.lastError, lastCheckedAt: iso(s.lastCheckedAt) };
}

export function serializeQueueItem(q: typeof S.queueItems.$inferSelect): C.QueueItem & { workerId: string } {
  return { id: q.id, workerId: q.workerId, ref: q.ref, title: q.title, source: q.source, status: q.status, confidence: q.confidence, amount: q.amount ?? undefined, assignee: q.assignee ?? undefined, updatedAt: q.updatedAt.toISOString(), fields: q.fields };
}

export function serializeInbox(c: typeof S.inboxConversations.$inferSelect): C.InboxConversation & { status: string; assignee: string | null; notes: string } {
  const mins = Math.max(0, Math.round((Date.now() - c.waitingSince.getTime()) / 60_000));
  return {
    id: c.id,
    customer: c.customer,
    phone: c.phone,
    channel: c.channel,
    worker: c.workerName,
    reason: c.reason,
    sentiment: c.sentiment,
    language: c.language,
    waiting: mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h`,
    summary: c.summary,
    transcript: c.transcript,
    status: c.status,
    assignee: c.assigneeName,
    notes: c.notes,
  };
}

export function serializeEvalCase(e: typeof S.evalCases.$inferSelect): C.EvalCase {
  return { id: e.id, input: e.input, expected: e.expected, category: e.category, score: e.score, pass: e.pass, ms: e.ms };
}

export function serializeUser(u: typeof S.users.$inferSelect): C.Profile & { id: string } {
  return { id: u.id, name: u.name, email: u.email, title: u.title, language: u.language as "en" | "hi", timezone: u.timezone, approvalChannel: u.approvalChannel as C.Profile["approvalChannel"], digest: u.digest as C.Profile["digest"], quietHours: u.quietHours };
}
