import { and, asc, desc, eq, gte, ilike, lt, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { apiKeys, auditEvents, notifications, policies, webhookDeliveries, webhooks } from "../db/schema.js";
import { sha256 } from "../lib/crypto.js";
import { assertFound } from "../lib/errors.js";
import { newId, randomString } from "../lib/ids.js";
import { auth } from "../plugins/auth.js";
import { evaluatePolicies, validateCondition } from "../runtime/policy.js";
import { audit, verifyAuditChain } from "../services/audit.js";
import { serializeApiKey, serializeAudit, serializeNotification, serializePolicy, serializeWebhook } from "../services/serializers.js";
import { WEBHOOK_EVENTS } from "../services/webhooks.js";
import { enqueue } from "../jobs/queue.js";

const condition = z.string().max(500).superRefine((s, ctx) => {
  const err = validateCondition(s);
  if (err) ctx.addIssue({ code: "custom", message: `Invalid condition: ${err}` });
});

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export const governanceRoutes: FastifyPluginAsyncZod = async (app) => {
  const idParam = z.object({ id: z.string() });

  // ─── Policies ───
  const ptags = ["policies"];
  const policyBody = z.object({ name: z.string().trim().min(1).max(200), appliesTo: z.string().trim().min(1).max(500), condition: condition.default("always"), effect: z.enum(["allow", "approve", "deny"]), approvers: z.string().max(200).nullable().optional(), enabled: z.boolean().default(true), priority: z.number().int().min(0).max(10_000).default(100) });

  app.get("/policies", { preHandler: app.authorize("workspace:read"), schema: { tags: ptags } }, async (req) => {
    const rows = await db.select().from(policies).where(eq(policies.workspaceId, auth(req).workspaceId)).orderBy(asc(policies.priority), asc(policies.createdAt));
    return { data: rows.map(serializePolicy) };
  });

  app.post("/policies", { preHandler: app.authorize("policies:manage"), schema: { tags: ptags, body: policyBody } }, async (req, reply) => {
    const a = auth(req);
    const [p] = await db.insert(policies).values({ id: newId("pol"), workspaceId: a.workspaceId, ...req.body, approvers: req.body.approvers ?? null }).returning();
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "policy.created", target: p.name, ip: req.ip, payload: req.body });
    return reply.status(201).send(serializePolicy(p));
  });

  app.patch("/policies/:id", { preHandler: app.authorize("policies:manage"), schema: { tags: ptags, params: idParam, body: policyBody.partial() } }, async (req) => {
    const a = auth(req);
    const [p] = await db.update(policies).set(req.body).where(and(eq(policies.id, req.params.id), eq(policies.workspaceId, a.workspaceId))).returning();
    assertFound(p, "Policy");
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "policy.updated", target: p.name, ip: req.ip, payload: req.body });
    return serializePolicy(p);
  });

  app.delete("/policies/:id", { preHandler: app.authorize("policies:manage"), schema: { tags: ptags, params: idParam } }, async (req, reply) => {
    const a = auth(req);
    const [p] = await db.delete(policies).where(and(eq(policies.id, req.params.id), eq(policies.workspaceId, a.workspaceId))).returning();
    assertFound(p, "Policy");
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "policy.deleted", target: p.name, ip: req.ip });
    return reply.status(204).send();
  });

  /** Dry-run: what would happen if this action ran with these facts? */
  app.post("/policies/evaluate", { preHandler: app.authorize("workspace:read"), schema: { tags: ptags, body: z.object({ action: z.string(), sideEffect: z.enum(["none", "write", "external", "destructive"]).default("write"), facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}) }) } }, async (req) => {
    return evaluatePolicies(auth(req).workspaceId, req.body.action, req.body.sideEffect, { action: req.body.action, ...req.body.facts });
  });

  // ─── API keys ───
  const dtags = ["developers"];
  app.get("/api-keys", { preHandler: app.authorize("developers:manage"), schema: { tags: dtags } }, async (req) => {
    const rows = await db.select().from(apiKeys).where(eq(apiKeys.workspaceId, auth(req).workspaceId)).orderBy(desc(apiKeys.createdAt));
    return { data: rows.map(serializeApiKey) };
  });

  /** The secret is returned once and only its SHA-256 is stored. */
  app.post("/api-keys", { preHandler: app.authorize("developers:manage"), schema: { tags: dtags, body: z.object({ name: z.string().trim().min(1).max(100), scope: z.string().trim().min(1).max(300).default("all"), test: z.boolean().default(false) }) } }, async (req, reply) => {
    const a = auth(req);
    const secret = `anv_${req.body.test ? "test" : "live"}_${randomString(40)}`;
    const [k] = await db.insert(apiKeys).values({ id: newId("key"), workspaceId: a.workspaceId, name: req.body.name, scope: req.body.scope, prefix: `${secret.slice(0, 9)}••••${secret.slice(-4)}`, keyHash: sha256(secret), createdBy: a.userId }).returning();
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "api_key.created", target: `${k.name} (${k.scope})`, ip: req.ip });
    return reply.status(201).send({ ...serializeApiKey(k), secret });
  });

  app.delete("/api-keys/:id", { preHandler: app.authorize("developers:manage"), schema: { tags: dtags, params: idParam } }, async (req) => {
    const a = auth(req);
    const [k] = await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.workspaceId, a.workspaceId))).returning();
    assertFound(k, "API key");
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "api_key.revoked", target: k.name, ip: req.ip });
    return serializeApiKey(k);
  });

  // ─── Outbound webhooks ───
  app.get("/webhooks", { preHandler: app.authorize("developers:manage"), schema: { tags: dtags } }, async (req) => {
    const rows = await db.select().from(webhooks).where(eq(webhooks.workspaceId, auth(req).workspaceId)).orderBy(asc(webhooks.createdAt));
    return { data: rows.map(serializeWebhook), events: WEBHOOK_EVENTS };
  });

  app.post("/webhooks", { preHandler: app.authorize("developers:manage"), schema: { tags: dtags, body: z.object({ url: z.string().url().refine((u) => u.startsWith("https://") || (config.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)), "Webhook URLs must use https"), events: z.array(z.enum([...WEBHOOK_EVENTS, "*"])).min(1), active: z.boolean().default(true) }) } }, async (req, reply) => {
    const a = auth(req);
    const secret = `whsec_${randomString(32)}`;
    const [w] = await db.insert(webhooks).values({ id: newId("whk"), workspaceId: a.workspaceId, url: req.body.url, events: req.body.events, active: req.body.active, secret }).returning();
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "webhook.created", target: w.url, ip: req.ip });
    return reply.status(201).send({ ...serializeWebhook(w), secret });
  });

  app.patch("/webhooks/:id", { preHandler: app.authorize("developers:manage"), schema: { tags: dtags, params: idParam, body: z.object({ events: z.array(z.enum([...WEBHOOK_EVENTS, "*"])).min(1).optional(), active: z.boolean().optional() }) } }, async (req) => {
    const a = auth(req);
    const [w] = await db.update(webhooks).set(req.body).where(and(eq(webhooks.id, req.params.id), eq(webhooks.workspaceId, a.workspaceId))).returning();
    return serializeWebhook(assertFound(w, "Webhook"));
  });

  app.delete("/webhooks/:id", { preHandler: app.authorize("developers:manage"), schema: { tags: dtags, params: idParam } }, async (req, reply) => {
    const a = auth(req);
    const [w] = await db.delete(webhooks).where(and(eq(webhooks.id, req.params.id), eq(webhooks.workspaceId, a.workspaceId))).returning();
    assertFound(w, "Webhook");
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "webhook.deleted", target: w.url, ip: req.ip });
    return reply.status(204).send();
  });

  app.post("/webhooks/:id/test", { preHandler: app.authorize("developers:manage"), schema: { tags: dtags, params: idParam } }, async (req, reply) => {
    const a = auth(req);
    const w = assertFound((await db.select().from(webhooks).where(and(eq(webhooks.id, req.params.id), eq(webhooks.workspaceId, a.workspaceId))))[0], "Webhook");
    const id = newId("whd");
    await db.insert(webhookDeliveries).values({ id, webhookId: w.id, workspaceId: a.workspaceId, event: "ping", payload: { id, type: "ping", createdAt: new Date().toISOString(), workspaceId: a.workspaceId, data: { message: "Hello from Anvita" } } });
    await enqueue("webhook.deliver", { deliveryId: id }, { maxAttempts: 1 });
    return reply.status(202).send({ deliveryId: id });
  });

  app.get("/webhooks/:id/deliveries", { preHandler: app.authorize("developers:manage"), schema: { tags: dtags, params: idParam } }, async (req) => {
    const a = auth(req);
    const rows = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.webhookId, req.params.id), eq(webhookDeliveries.workspaceId, a.workspaceId))).orderBy(desc(webhookDeliveries.createdAt)).limit(100);
    return { data: rows.map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, responseCode: d.responseCode, lastError: d.lastError, createdAt: d.createdAt.toISOString(), deliveredAt: d.deliveredAt?.toISOString() ?? null })) };
  });

  // ─── Notifications (per user) ───
  app.get("/notifications", { preHandler: app.authorize("workspace:read"), schema: { tags: ["notifications"], querystring: z.object({ unread: z.coerce.boolean().optional() }) } }, async (req) => {
    const a = auth(req);
    const conds = [eq(notifications.workspaceId, a.workspaceId), eq(notifications.userId, a.userId ?? "")];
    if (req.query.unread) conds.push(eq(notifications.read, false));
    const rows = await db.select().from(notifications).where(and(...conds)).orderBy(desc(notifications.createdAt)).limit(100);
    return { data: rows.map(serializeNotification), unread: rows.filter((n) => !n.read).length };
  });

  app.post("/notifications/read", { preHandler: app.authorize("workspace:read"), schema: { tags: ["notifications"], body: z.object({ id: z.string().optional() }).default({}) } }, async (req) => {
    const a = auth(req);
    const conds = [eq(notifications.workspaceId, a.workspaceId), eq(notifications.userId, a.userId ?? "")];
    if (req.body.id) conds.push(eq(notifications.id, req.body.id));
    const rows = await db.update(notifications).set({ read: true }).where(and(...conds)).returning({ id: notifications.id });
    return { updated: rows.length };
  });

  // ─── Audit log ───
  const auditQuery = z.object({ q: z.string().optional(), actorType: z.enum(["user", "agent", "worker", "system"]).optional(), action: z.string().optional(), since: z.string().datetime().optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), format: z.enum(["json", "csv"]).default("json") });
  app.get("/audit", { preHandler: app.authorize("audit:read"), schema: { tags: ["audit"], querystring: auditQuery } }, async (req, reply) => {
    const a = auth(req);
    const q = req.query;
    const conds = [eq(auditEvents.workspaceId, a.workspaceId)];
    if (q.q) conds.push(or(ilike(auditEvents.actor, `%${q.q}%`), ilike(auditEvents.action, `%${q.q}%`), ilike(auditEvents.target, `%${q.q}%`))!);
    if (q.actorType) conds.push(eq(auditEvents.actorType, q.actorType));
    if (q.action) conds.push(ilike(auditEvents.action, `${q.action}%`));
    if (q.since) conds.push(gte(auditEvents.createdAt, new Date(q.since)));
    if (q.before) conds.push(lt(auditEvents.id, q.before));
    const rows = await db.select().from(auditEvents).where(and(...conds)).orderBy(desc(auditEvents.id)).limit(q.format === "csv" ? 10_000 : q.limit);
    if (q.format === "csv") {
      const lines = ["time,actor,actor_type,action,target,channel,ip,hash", ...rows.map((r) => [r.createdAt.toISOString(), r.actor, r.actorType, r.action, r.target, r.channel, r.ip, r.hash].map(csvCell).join(","))];
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
      return reply.send(lines.join("\n"));
    }
    return { data: rows.map(serializeAudit), nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null };
  });

  app.get("/audit/verify", { preHandler: app.authorize("audit:read"), schema: { tags: ["audit"] } }, async (req) => verifyAuditChain(auth(req).workspaceId));

};
