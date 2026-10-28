import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { blankWorker, compileThread, workerFromDescription, workerFromTemplate } from "../catalog/factory.js";
import { templateById, templates } from "../catalog/index.js";
import type { ChatBlock, Thread, Worker } from "../contracts/web.js";
import { db } from "../db/client.js";
import { evalCases, messages, queueItems, runs, threads, workers, workerVersions } from "../db/schema.js";
import { hmacSha256, safeEqual } from "../lib/crypto.js";
import { assertFound, badRequest, forbidden, unauthorized } from "../lib/errors.js";
import { CLIENT_ID_RE, newId, randomString } from "../lib/ids.js";
import { enqueue } from "../jobs/queue.js";
import { auth } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { serializeEvalCase, serializeMessage, serializeQueueItem, serializeRun, serializeThread, serializeWorker } from "../services/serializers.js";
import { emitWebhook } from "../services/webhooks.js";
import { parseCron, startWorkerRun, workerStats } from "../services/workers.js";
import { publish } from "../services/events.js";
import { AppError } from "../lib/errors.js";
import { connections } from "../db/schema.js";
import { workspaceRegistry } from "../runtime/tools/registry.js";
import { sandboxAvailable } from "../sandbox/index.js";
import { FUNCTION_NAMES } from "../workflow/expr.js";
import { validateWorkflow } from "../workflow/validate.js";

type WorkerRow = typeof workers.$inferSelect;

async function validateFor(workspaceId: string, w: WorkerRow, graph: { nodes: WorkerRow["nodes"]; edges: WorkerRow["edges"] }) {
  const [registry, conns, all] = await Promise.all([
    workspaceRegistry(workspaceId),
    db.select({ appId: connections.appId, status: connections.status }).from(connections).where(eq(connections.workspaceId, workspaceId)),
    db.select({ id: workers.id, name: workers.name }).from(workers).where(eq(workers.workspaceId, workspaceId)),
  ]);
  return validateWorkflow(graph, { registry, connectedApps: new Set(conns.filter((c) => c.status === "healthy").map((c) => c.appId)), workerIds: new Set(all.flatMap((x) => [x.id, x.name])), selfId: w.id });
}

const node = z.object({
  id: z.string().min(1).max(64),
  kind: z.string(),
  title: z.string().max(200),
  subtitle: z.string().max(500).optional(),
  appId: z.string().optional(),
  x: z.number(),
  y: z.number(),
  // Step settings: strings may hold {{ expressions }}; objects map tool inputs; code steps hold source.
  config: z.record(z.string(), z.unknown()).refine((c) => JSON.stringify(c).length <= 200_000, "Step settings are too large").optional(),
});
const edge = z.object({ id: z.string(), source: z.string(), target: z.string(), label: z.string().optional() });
const interaction = z.enum(["chat", "queue", "voice", "api", "document", "scheduled"]);
const cron = z.string().refine((s) => {
  try {
    parseCron(s);
    return true;
  } catch {
    return false;
  }
}, "Invalid cron expression (5 fields, UTC)");

const workerPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(20_000).optional(),
  emoji: z.string().max(8).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  interaction: interaction.optional(),
  channels: z.array(z.string()).max(20).optional(),
  apps: z.array(z.string()).max(30).optional(),
  trigger: z.string().max(200).optional(),
  schedule: cron.nullable().optional(),
  pinned: z.boolean().optional(),
  nodes: z.array(node).max(500).optional(),
  edges: z.array(edge).max(1000).optional(),
  engine: z.enum(["graph", "agent"]).optional(),
});

function cronFromTrigger(w: Pick<Worker, "interaction" | "nodes">): string | null {
  if (w.interaction !== "scheduled") return null;
  const c = w.nodes.find((n) => n.kind === "trigger")?.config?.cron;
  if (typeof c !== "string") return "30 3 * * 1"; // Monday 09:00 IST
  try {
    parseCron(c);
    // Templates express IST wall time; schedules are stored in UTC (IST = UTC+5:30).
    const [m, h, dom, mon, dow] = c.split(/\s+/);
    if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
      const ist = Number(h) * 60 + Number(m);
      const total = (ist - 330 + 1440) % 1440;
      // Crossing midnight backwards moves the weekday back by one.
      const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      const shiftDow = (d: string) => d.replace(/[A-Za-z]{3}|\d/g, (x) => { const i = /\d/.test(x) ? Number(x) % 7 : days.indexOf(x.toUpperCase()); return i < 0 ? x : days[(i + 6) % 7]; });
      return [String(total % 60), String(Math.floor(total / 60)), dom, mon, ist < 330 && dow !== "*" ? shiftDow(dow) : dow].join(" ");
    }
    return c;
  } catch {
    return null;
  }
}

async function loadWorker(workspaceId: string, id: string) {
  return assertFound((await db.select().from(workers).where(and(eq(workers.id, id), eq(workers.workspaceId, workspaceId))))[0], "Worker");
}

export const workerRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ["workers"];
  const idParam = z.object({ id: z.string() });

  app.get("/templates", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async () => ({ data: templates }));

  app.get("/workers", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => {
    const a = auth(req);
    const rows = await db.select().from(workers).where(eq(workers.workspaceId, a.workspaceId)).orderBy(desc(workers.pinned), desc(workers.updatedAt));
    const stats = await workerStats(a.workspaceId);
    return { data: rows.map((w) => serializeWorker(w, stats.get(w.id))) };
  });

  /** Autopilot: draft a Worker graph from a description without saving it. */
  app.post("/workers/draft", { preHandler: app.authorize("workers:write"), schema: { tags, body: z.object({ description: z.string().trim().min(5).max(5000) }) } }, async (req) => {
    return workerFromDescription(req.body.description, auth(req).userName);
  });

  /**
   * Create a Worker from: a template, a description (Autopilot), a chat thread ("Save as AI Worker"),
   * or blank. Explicit fields override the generated ones.
   */
  app.post(
    "/workers",
    {
      preHandler: app.authorize("workers:write"),
      schema: {
        tags,
        body: workerPatch.extend({
          id: z.string().regex(CLIENT_ID_RE).optional(),
          createdFrom: z.enum(["template", "run", "autopilot", "scratch"]).optional(),
          from: z.enum(["blank", "template", "description", "thread"]).default("blank"),
          templateId: z.string().optional(),
          threadId: z.string().optional(),
          scheduleLabel: z.string().max(100).optional(),
        }),
      },
    },
    async (req, reply) => {
      const a = auth(req);
      const { id: clientId, createdFrom, from, templateId, threadId, scheduleLabel, ...overrides } = req.body;
      let base: Worker;
      let sourceRunId: string | null = null;
      if (from === "template") {
        const tpl = templateById[templateId ?? ""];
        if (!tpl) throw badRequest("Unknown templateId");
        base = workerFromTemplate(tpl, a.userName);
      } else if (from === "description") {
        if (!overrides.description) throw badRequest("description is required");
        base = workerFromDescription(overrides.description, a.userName);
      } else if (from === "thread") {
        const t = assertFound((await db.select().from(threads).where(and(eq(threads.id, threadId ?? ""), eq(threads.workspaceId, a.workspaceId))))[0], "Thread");
        const msgs = await db.select().from(messages).where(eq(messages.threadId, t.id)).orderBy(asc(messages.createdAt));
        const thread = { ...serializeThread(t), messages: msgs.map(serializeMessage) } as unknown as Thread;
        base = compileThread(thread, overrides.name ?? t.title, a.userName, scheduleLabel ?? "Every Monday 09:00 IST");
        base.status = "draft";
        base.version = 0;
        sourceRunId = msgs.findLast((m) => m.runId)?.runId ?? null;
        // Mark the "Save as AI Worker" card as saved.
        for (const m of msgs) {
          const blocks = m.blocks as ChatBlock[];
          if (blocks.some((b) => b.type === "harden" && b.status === "offered")) {
            const [u] = await db.update(messages).set({ blocks: blocks.map((b) => (b.type === "harden" ? { ...b, status: "saved" } : b)) }).where(eq(messages.id, m.id)).returning();
            await publish({ workspaceId: a.workspaceId, threadId: t.id, type: "message.updated", data: serializeMessage(u) });
          }
        }
      } else {
        base = blankWorker(a.userName);
      }
      const merged = { ...base, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } as Worker & { instructions?: string; schedule?: string | null };
      const [w] = await db
        .insert(workers)
        .values({
          id: clientId ?? newId("wrk"),
          workspaceId: a.workspaceId,
          name: merged.name,
          description: merged.description,
          instructions: merged.instructions ?? "",
          emoji: merged.emoji,
          color: merged.color,
          interaction: merged.interaction,
          channels: merged.channels,
          status: "draft",
          version: 0,
          ownerId: a.userId,
          ownerName: a.userName,
          apps: merged.apps,
          trigger: merged.trigger,
          schedule: merged.schedule !== undefined ? merged.schedule : cronFromTrigger(merged),
          createdFrom: createdFrom ?? (from === "thread" ? "run" : (merged.createdFrom ?? "scratch")),
          sourceRunId,
          templateId: templateId ?? null,
          pinned: merged.pinned ?? false,
          nodes: merged.nodes,
          edges: merged.edges,
          webhookSecret: `whsec_${randomString(32)}`,
        })
        .returning();
      await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "worker.created", target: w.name, ip: req.ip });
      return reply.status(201).send(serializeWorker(w));
    },
  );

  app.get("/workers/:id", { preHandler: app.authorize("workspace:read"), schema: { tags, params: idParam } }, async (req) => {
    const a = auth(req);
    const w = await loadWorker(a.workspaceId, req.params.id);
    const canSeeSecret = !a.apiKeyId && ["owner", "admin", "builder"].includes(a.role);
    return { ...serializeWorker(w, (await workerStats(a.workspaceId)).get(w.id)), ...(canSeeSecret ? { webhookUrl: `/v1/hooks/workers/${w.id}`, webhookSecret: w.webhookSecret } : {}) };
  });

  app.patch("/workers/:id", { preHandler: app.authorize("workers:write"), schema: { tags, params: idParam, body: workerPatch } }, async (req) => {
    const a = auth(req);
    await loadWorker(a.workspaceId, req.params.id);
    const [w] = await db.update(workers).set({ ...req.body, updatedAt: new Date() }).where(eq(workers.id, req.params.id)).returning();
    return serializeWorker(w);
  });

  app.delete("/workers/:id", { preHandler: app.authorize("workers:write"), schema: { tags, params: idParam } }, async (req, reply) => {
    const a = auth(req);
    const w = await loadWorker(a.workspaceId, req.params.id);
    await db.delete(workers).where(eq(workers.id, w.id));
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "worker.deleted", target: w.name, ip: req.ip });
    return reply.status(204).send();
  });

  app.post("/workers/:id/duplicate", { preHandler: app.authorize("workers:write"), schema: { tags, params: idParam, body: z.object({ id: z.string().regex(CLIENT_ID_RE).optional() }).default({}) } }, async (req, reply) => {
    const a = auth(req);
    const w = await loadWorker(a.workspaceId, req.params.id);
    const [copy] = await db.insert(workers).values({ ...w, id: req.body.id ?? newId("wrk"), name: `${w.name} (copy)`, status: "draft", version: 0, ownerId: a.userId, ownerName: a.userName, pinned: false, webhookSecret: `whsec_${randomString(32)}`, lastScheduledAt: null, createdAt: new Date(), updatedAt: new Date() }).returning();
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "worker.created", target: `${copy.name} (duplicate)`, ip: req.ip });
    return reply.status(201).send(serializeWorker(copy));
  });

  /** Check a graph (the saved one, or unsaved nodes/edges from the Studio) before running or publishing. */
  app.post("/workers/:id/validate", { preHandler: app.authorize("workspace:read"), schema: { tags, params: idParam, body: z.object({ nodes: z.array(node).max(500).optional(), edges: z.array(edge).max(1000).optional() }).default({}) } }, async (req) => {
    const a = auth(req);
    const w = await loadWorker(a.workspaceId, req.params.id);
    const issues = await validateFor(a.workspaceId, w, { nodes: (req.body.nodes as WorkerRow["nodes"]) ?? w.nodes, edges: req.body.edges ?? w.edges });
    return { ok: !issues.some((i) => i.level === "error"), issues };
  });

  /** What the Studio can build with: step types, every action (with input schemas) and expression functions. */
  app.get("/workflow/catalog", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => {
    const a = auth(req);
    const reg = await workspaceRegistry(a.workspaceId);
    return {
      actions: reg.tools.filter((t) => t.kind !== "plan").map((t) => ({ action: t.action, name: t.name, appId: t.appId, kind: t.kind, description: t.description, sideEffect: t.sideEffect, inputSchema: t.inputSchema })),
      functions: FUNCTION_NAMES,
      channels: ["reply", "slack", "whatsapp", "gmail", "outlook", "teams", "webhook"],
      sandbox: sandboxAvailable(),
    };
  });

  /** Publish: snapshot the current graph as an immutable version and go live. */
  app.post("/workers/:id/publish", { preHandler: app.authorize("workers:write"), schema: { tags, params: idParam, body: z.object({ note: z.string().max(500).optional(), canary: z.boolean().optional() }).default({}) } }, async (req) => {
    const a = auth(req);
    const w = await loadWorker(a.workspaceId, req.params.id);
    if (!w.nodes.some((n) => n.kind === "trigger")) throw badRequest("Add a trigger before publishing");
    if (w.engine === "graph") {
      const issues = await validateFor(a.workspaceId, w, { nodes: w.nodes, edges: w.edges });
      const errors = issues.filter((i) => i.level === "error");
      if (errors.length) throw new AppError(422, "workflow_invalid", `Fix ${errors.length} problem${errors.length > 1 ? "s" : ""} before publishing: ${errors[0].message}`, { issues });
    }
    const version = w.version + 1;
    const { id: _id, workspaceId: _ws, createdAt: _c, updatedAt: _u, webhookSecret: _s, ...snapshot } = w;
    const updated = await db.transaction(async (tx) => {
      await tx.insert(workerVersions).values({ id: newId("wv"), workerId: w.id, workspaceId: a.workspaceId, version, snapshot: { ...snapshot, version }, note: req.body.note ?? null, publishedBy: a.userName });
      const [u] = await tx.update(workers).set({ version, status: req.body.canary ? "canary" : "live", updatedAt: new Date() }).where(eq(workers.id, w.id)).returning();
      return u;
    });
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "worker.published", target: `${w.name} v${version}`, ip: req.ip });
    await emitWebhook(a.workspaceId, "worker.published", { id: w.id, name: w.name, version });
    return serializeWorker(updated);
  });

  app.get("/workers/:id/versions", { preHandler: app.authorize("workspace:read"), schema: { tags, params: idParam } }, async (req) => {
    const a = auth(req);
    await loadWorker(a.workspaceId, req.params.id);
    const rows = await db.select().from(workerVersions).where(eq(workerVersions.workerId, req.params.id)).orderBy(desc(workerVersions.version));
    return { data: rows.map((v) => ({ id: v.id, version: v.version, note: v.note, publishedBy: v.publishedBy, createdAt: v.createdAt.toISOString(), snapshot: v.snapshot })) };
  });

  /** Roll back: restore a published version's graph into the working copy. */
  app.post("/workers/:id/versions/:version/restore", { preHandler: app.authorize("workers:write"), schema: { tags, params: z.object({ id: z.string(), version: z.coerce.number().int() }) } }, async (req) => {
    const a = auth(req);
    await loadWorker(a.workspaceId, req.params.id);
    const [v] = await db.select().from(workerVersions).where(and(eq(workerVersions.workerId, req.params.id), eq(workerVersions.version, req.params.version)));
    const snap = assertFound(v, "Version").snapshot as Partial<typeof workers.$inferSelect>;
    const [w] = await db.update(workers).set({ nodes: snap.nodes, edges: snap.edges, instructions: snap.instructions, apps: snap.apps, description: snap.description, updatedAt: new Date() }).where(eq(workers.id, req.params.id)).returning();
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "worker.restored", target: `${w.name} → v${req.params.version}`, ip: req.ip });
    return serializeWorker(w);
  });

  app.post("/workers/:id/status", { preHandler: app.authorize("workers:write"), schema: { tags, params: idParam, body: z.object({ status: z.enum(["live", "paused", "canary", "draft"]) }) } }, async (req) => {
    const a = auth(req);
    const w = await loadWorker(a.workspaceId, req.params.id);
    if (req.body.status !== "draft" && w.version === 0) throw badRequest("Publish the Worker first");
    const [u] = await db.update(workers).set({ status: req.body.status, updatedAt: new Date() }).where(eq(workers.id, w.id)).returning();
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: `worker.${req.body.status === "paused" ? "paused" : req.body.status === "live" ? "resumed" : req.body.status}`, target: w.name, ip: req.ip });
    return serializeWorker(u);
  });

  /** Run a Worker now (manual or API). `test: true` runs a draft in test mode. */
  app.post("/workers/:id/runs", { preHandler: app.authorize("workers:run"), schema: { tags, params: idParam, body: z.object({ inputs: z.record(z.string(), z.unknown()).optional(), test: z.boolean().optional() }).default({}) } }, async (req, reply) => {
    const a = auth(req);
    const w = await loadWorker(a.workspaceId, req.params.id);
    if (a.apiKeyId && a.scopes && !a.scopes.some((s) => s === "all" || s === "workers:run" || s === `workers:${w.id}:run` || s.startsWith("workers:run"))) throw forbidden("API key scope doesn't allow running this Worker");
    const run = await startWorkerRun(w, { trigger: a.apiKeyId ? "API" : "Manual", inputs: req.body.inputs, createdBy: a.userId, createdByName: a.userName, test: req.body.test });
    return reply.status(202).send(serializeRun(run));
  });

  app.get("/workers/:id/runs", { preHandler: app.authorize("workspace:read"), schema: { tags, params: idParam, querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) } }, async (req) => {
    const a = auth(req);
    await loadWorker(a.workspaceId, req.params.id);
    const rows = await db.select().from(runs).where(and(eq(runs.workspaceId, a.workspaceId), eq(runs.workerId, req.params.id))).orderBy(desc(runs.createdAt)).limit(req.query.limit);
    return { data: rows.map(serializeRun) };
  });

  // ─── Evals ───

  app.get("/workers/:id/evals", { preHandler: app.authorize("workspace:read"), schema: { tags, params: idParam } }, async (req) => {
    const a = auth(req);
    await loadWorker(a.workspaceId, req.params.id);
    const rows = await db.select().from(evalCases).where(eq(evalCases.workerId, req.params.id)).orderBy(asc(evalCases.createdAt));
    const passed = rows.filter((r) => r.pass).length;
    return { data: rows.map(serializeEvalCase), summary: { total: rows.length, passed, passRate: rows.length ? passed / rows.length : 0, lastRunAt: rows.reduce<Date | null>((m, r) => (r.lastRunAt && (!m || r.lastRunAt > m) ? r.lastRunAt : m), null)?.toISOString() ?? null } };
  });

  app.put("/workers/:id/evals", { preHandler: app.authorize("workers:write"), schema: { tags, params: idParam, body: z.object({ cases: z.array(z.object({ id: z.string().optional(), input: z.string().min(1).max(5000), expected: z.string().min(1).max(5000), category: z.string().max(50).default("general"), score: z.number().min(0).max(1).optional(), pass: z.boolean().optional(), ms: z.number().int().min(0).optional() })).max(200) }) } }, async (req) => {
    const a = auth(req);
    await loadWorker(a.workspaceId, req.params.id);
    await db.transaction(async (tx) => {
      await tx.delete(evalCases).where(eq(evalCases.workerId, req.params.id));
      if (req.body.cases.length) await tx.insert(evalCases).values(req.body.cases.map((c) => ({ id: newId("evc"), workerId: req.params.id, workspaceId: a.workspaceId, input: c.input, expected: c.expected, category: c.category, score: c.score ?? 0, pass: c.pass ?? false, ms: c.ms ?? 0, lastRunAt: c.score !== undefined ? new Date() : null })));
    });
    const rows = await db.select().from(evalCases).where(eq(evalCases.workerId, req.params.id)).orderBy(asc(evalCases.createdAt));
    return { data: rows.map(serializeEvalCase) };
  });

  app.post("/workers/:id/evals/run", { preHandler: app.authorize("workers:write"), schema: { tags, params: idParam } }, async (req, reply) => {
    const a = auth(req);
    await loadWorker(a.workspaceId, req.params.id);
    await enqueue("evals.run", { workerId: req.params.id, workspaceId: a.workspaceId }, { dedupeKey: `evals:${req.params.id}`, maxAttempts: 2 });
    return reply.status(202).send({ status: "queued" });
  });

  // ─── Work queue ───

  app.get("/workers/:id/queue", { preHandler: app.authorize("workspace:read"), schema: { tags: ["queue"], params: idParam, querystring: z.object({ status: z.string().optional() }) } }, async (req) => {
    const a = auth(req);
    await loadWorker(a.workspaceId, req.params.id);
    const conds = [eq(queueItems.workerId, req.params.id)];
    if (req.query.status) conds.push(sql`${queueItems.status} = any(${req.query.status.split(",")})`);
    const rows = await db.select().from(queueItems).where(and(...conds)).orderBy(desc(queueItems.updatedAt)).limit(500);
    return { data: rows.map(serializeQueueItem) };
  });

  app.post("/workers/:id/queue", { preHandler: app.authorize("workers:run"), schema: { tags: ["queue"], params: idParam, body: z.object({ ref: z.string().max(100), title: z.string().max(300), source: z.string().max(100).default("API"), amount: z.string().max(50).optional(), confidence: z.number().min(0).max(1).default(0), fields: z.array(z.object({ label: z.string(), value: z.string(), confidence: z.number().optional() })).max(100).default([]), status: z.enum(["needs_review", "processing", "done", "failed", "escalated"]).default("needs_review") }) } }, async (req, reply) => {
    const a = auth(req);
    await loadWorker(a.workspaceId, req.params.id);
    const [q] = await db.insert(queueItems).values({ id: newId("qi"), workspaceId: a.workspaceId, workerId: req.params.id, ...req.body }).returning();
    await publish({ workspaceId: a.workspaceId, type: "queue.updated", data: serializeQueueItem(q) });
    return reply.status(201).send(serializeQueueItem(q));
  });

  app.patch("/queue/:id", { preHandler: app.authorize("inbox:write"), schema: { tags: ["queue"], params: idParam, body: z.object({ status: z.enum(["needs_review", "processing", "done", "failed", "escalated"]).optional(), assignee: z.string().max(100).nullable().optional(), fields: z.array(z.object({ label: z.string(), value: z.string(), confidence: z.number().optional() })).max(100).optional() }) } }, async (req) => {
    const a = auth(req);
    const [q] = await db.update(queueItems).set({ ...req.body, updatedAt: new Date() }).where(and(eq(queueItems.id, req.params.id), eq(queueItems.workspaceId, a.workspaceId))).returning();
    assertFound(q, "Queue item");
    if (req.body.status) await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: `queue.${req.body.status}`, target: `${q.ref} · ${q.title}`, ip: req.ip });
    await publish({ workspaceId: a.workspaceId, type: "queue.updated", data: serializeQueueItem(q) });
    return serializeQueueItem(q);
  });
};

/**
 * Public trigger endpoint (no user auth): `POST /hooks/workers/:id` signed with the Worker's secret
 * using the same `Anvita-Signature: t=…,v1=…` scheme as outbound webhooks.
 */
export const workerHookRoutes: FastifyPluginAsyncZod = async (app) => {
  // Keep the exact bytes for signature verification.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });
  app.post("/hooks/workers/:id", { schema: { tags: ["workers"], security: [], params: z.object({ id: z.string() }) } }, async (req, reply) => {
    const [w] = await db.select().from(workers).where(eq(workers.id, req.params.id));
    if (!w?.webhookSecret) throw unauthorized("Unknown worker");
    const sig = String(req.headers["anvita-signature"] ?? "");
    const t = /t=(\d+)/.exec(sig)?.[1];
    const v1 = /v1=([0-9a-f]+)/.exec(sig)?.[1];
    const body = (req as unknown as { rawBody?: string }).rawBody ?? "";
    if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300 || !safeEqual(v1, hmacSha256(w.webhookSecret, `${t}.${body}`))) throw unauthorized("Invalid signature");
    const run = await startWorkerRun(w, { trigger: "Webhook", inputs: (req.body ?? {}) as Record<string, unknown> });
    return reply.status(202).send({ runId: run.id });
  });
};
