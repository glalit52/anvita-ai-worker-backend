import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { appById, apps, SYSTEM_APPS } from "../catalog/index.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { connections, mcpServers } from "../db/schema.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { assertFound, badRequest } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { auth } from "../plugins/auth.js";
import { resumeRunsWaitingForApp } from "../runtime/agent.js";
import { audit } from "../services/audit.js";
import { publish } from "../services/events.js";
import { serializeConnection, serializeMcp } from "../services/serializers.js";

const scope = z.enum(["workspace", "user", "shared"]);
const credentials = z.record(z.string(), z.string().max(4000)).optional();

async function probe(url: string, token?: string | null): Promise<"healthy" | "error"> {
  try {
    const res = await fetch(url, { method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000), redirect: "manual" });
    return res.status < 500 ? "healthy" : "error";
  } catch {
    return "error";
  }
}

export const integrationRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ["integrations"];

  app.get("/apps", { preHandler: app.authorize("workspace:read"), schema: { tags, querystring: z.object({ q: z.string().optional(), category: z.string().optional() }) } }, async (req) => {
    const a = auth(req);
    const conns = await db.select({ appId: connections.appId, status: connections.status }).from(connections).where(eq(connections.workspaceId, a.workspaceId));
    const byApp = new Map(conns.map((c) => [c.appId, c.status]));
    const q = req.query.q?.toLowerCase();
    return {
      data: apps
        .filter((x) => (!q || `${x.name} ${x.description}`.toLowerCase().includes(q)) && (!req.query.category || x.category === req.query.category))
        .map((x) => ({ ...x, connection: byApp.get(x.id) ?? null })),
    };
  });

  app.get("/connections", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => {
    const rows = await db.select().from(connections).where(eq(connections.workspaceId, auth(req).workspaceId)).orderBy(asc(connections.createdAt));
    return { data: rows.map(serializeConnection) };
  });

  /**
   * Connect (or reconnect) an app. Credentials (API key / bot token / OAuth tokens from the
   * aggregator) are encrypted at rest and never returned. Without credentials, the app uses the
   * demo driver so flows can be tried end-to-end. Runs waiting on this app resume automatically.
   */
  app.post("/connections", { preHandler: app.authorize("connections:write"), schema: { tags, body: z.object({ appId: z.string(), scope: scope.default("workspace"), credentials, sharedWith: z.array(z.string()).max(50).optional() }) } }, async (req, reply) => {
    const a = auth(req);
    if (!appById[req.body.appId]) throw badRequest(`Unknown app ${req.body.appId}`);
    const values = {
      scope: req.body.scope,
      ownerUserId: a.userId,
      connectedByName: a.userName,
      status: "healthy" as const,
      sharedWith: req.body.sharedWith ?? [],
      credentialsEnc: req.body.credentials ? encrypt(JSON.stringify(req.body.credentials)) : null,
    };
    const [row] = await db
      .insert(connections)
      .values({ id: newId("con"), workspaceId: a.workspaceId, appId: req.body.appId, ...values })
      .onConflictDoUpdate({ target: [connections.workspaceId, connections.appId], set: { ...values, ...(req.body.credentials ? {} : { credentialsEnc: undefined }) } })
      .returning();
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "connection.created", target: `${req.body.appId} (${req.body.scope})`, ip: req.ip });
    await publish({ workspaceId: a.workspaceId, type: "connection.updated", data: serializeConnection(row) });
    await resumeRunsWaitingForApp(a.workspaceId, req.body.appId);
    return reply.status(201).send(serializeConnection(row));
  });

  app.patch("/connections/:appId", { preHandler: app.authorize("connections:write"), schema: { tags, params: z.object({ appId: z.string() }), body: z.object({ scope: scope.optional(), sharedWith: z.array(z.string()).max(50).optional(), status: z.enum(["healthy", "expired", "error"]).optional(), credentials }) } }, async (req) => {
    const a = auth(req);
    const { credentials: creds, ...rest } = req.body;
    const [row] = await db.update(connections).set({ ...rest, ...(creds ? { credentialsEnc: encrypt(JSON.stringify(creds)) } : {}) }).where(and(eq(connections.workspaceId, a.workspaceId), eq(connections.appId, req.params.appId))).returning();
    assertFound(row, "Connection");
    await publish({ workspaceId: a.workspaceId, type: "connection.updated", data: serializeConnection(row) });
    if (row.status === "healthy") await resumeRunsWaitingForApp(a.workspaceId, row.appId);
    return serializeConnection(row);
  });

  /** Verify stored credentials still work (live drivers) — currently Slack auth.test; others report configured state. */
  app.post("/connections/:appId/test", { preHandler: app.authorize("connections:write"), schema: { tags, params: z.object({ appId: z.string() }) } }, async (req) => {
    const a = auth(req);
    const row = assertFound((await db.select().from(connections).where(and(eq(connections.workspaceId, a.workspaceId), eq(connections.appId, req.params.appId))))[0], "Connection");
    const creds = row.credentialsEnc ? (JSON.parse(decrypt(row.credentialsEnc)) as Record<string, string>) : null;
    if (row.appId === "slack" && creds?.botToken) {
      const res = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${creds.botToken}` }, signal: AbortSignal.timeout(10_000) });
      const body = (await res.json()) as { ok: boolean; error?: string; team?: string };
      await db.update(connections).set({ status: body.ok ? "healthy" : "error" }).where(eq(connections.id, row.id));
      return { ok: body.ok, mode: "live", detail: body.ok ? `Connected to ${body.team}` : body.error };
    }
    return { ok: row.status === "healthy", mode: creds ? "credentials_stored" : "demo", detail: creds ? "Credentials stored" : "Using the demo connector (no credentials)" };
  });

  app.delete("/connections/:appId", { preHandler: app.authorize("connections:write"), schema: { tags, params: z.object({ appId: z.string() }) } }, async (req, reply) => {
    const a = auth(req);
    if (SYSTEM_APPS.has(req.params.appId)) throw badRequest("Built-in apps can't be disconnected");
    const [row] = await db.delete(connections).where(and(eq(connections.workspaceId, a.workspaceId), eq(connections.appId, req.params.appId))).returning();
    assertFound(row, "Connection");
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "connection.revoked", target: req.params.appId, ip: req.ip });
    await publish({ workspaceId: a.workspaceId, type: "connection.deleted", data: { appId: req.params.appId } });
    return reply.status(204).send();
  });

  // ─── MCP servers ───

  app.get("/mcp-servers", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => {
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.workspaceId, auth(req).workspaceId)).orderBy(asc(mcpServers.createdAt));
    return { data: rows.map(serializeMcp) };
  });

  app.post("/mcp-servers", { preHandler: app.authorize("connections:write"), schema: { tags, body: z.object({ name: z.string().trim().min(1).max(100), url: z.string().url().refine((u) => u.startsWith("https://") || (config.NODE_ENV !== "production" && /^http:\/\/localhost[:/]/.test(u)), "Use an https:// URL"), auth: z.enum(["oauth", "bearer", "none"]).default("none"), token: z.string().max(4000).optional() }) } }, async (req, reply) => {
    const a = auth(req);
    const status = await probe(req.body.url, req.body.token);
    const [row] = await db.insert(mcpServers).values({ id: newId("mcp"), workspaceId: a.workspaceId, name: req.body.name, url: req.body.url, auth: req.body.auth, tokenEnc: req.body.token ? encrypt(req.body.token) : null, status }).returning();
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "mcp.server.added", target: req.body.url, ip: req.ip });
    return reply.status(201).send(serializeMcp(row));
  });

  app.post("/mcp-servers/:id/check", { preHandler: app.authorize("connections:write"), schema: { tags, params: z.object({ id: z.string() }) } }, async (req) => {
    const a = auth(req);
    const row = assertFound((await db.select().from(mcpServers).where(and(eq(mcpServers.id, req.params.id), eq(mcpServers.workspaceId, a.workspaceId))))[0], "MCP server");
    const status = await probe(row.url, row.tokenEnc ? decrypt(row.tokenEnc) : null);
    const [u] = await db.update(mcpServers).set({ status }).where(eq(mcpServers.id, row.id)).returning();
    return serializeMcp(u);
  });

  app.delete("/mcp-servers/:id", { preHandler: app.authorize("connections:write"), schema: { tags, params: z.object({ id: z.string() }) } }, async (req, reply) => {
    const a = auth(req);
    const [row] = await db.delete(mcpServers).where(and(eq(mcpServers.id, req.params.id), eq(mcpServers.workspaceId, a.workspaceId))).returning();
    assertFound(row, "MCP server");
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "mcp.server.removed", target: row.url, ip: req.ip });
    return reply.status(204).send();
  });
};
