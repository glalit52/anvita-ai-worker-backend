import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { appById, apps, SYSTEM_APPS } from "../catalog/index.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { connections, mcpServers, memberships } from "../db/schema.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { assertFound, badRequest } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { auth } from "../plugins/auth.js";
import { resumeRunsWaitingForApp } from "../runtime/agent.js";
import { connectorFor, oauthConfigured } from "../connectors/index.js";
import { authorizeUrl, exchangeCode, readState, type ConnectState } from "../connectors/oauth.js";
import { ConnectorError } from "../connectors/types.js";
import { apiKeyCredentials, retestConnection, saveConnection } from "../services/connections.js";
import { can } from "../services/rbac.js";
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
    const conns = await db.select({ appId: connections.appId, status: connections.status, mode: connections.mode }).from(connections).where(eq(connections.workspaceId, a.workspaceId));
    const byApp = new Map(conns.map((c) => [c.appId, c]));
    const q = req.query.q?.toLowerCase();
    return {
      data: apps
        .filter((x) => (!q || `${x.name} ${x.description}`.toLowerCase().includes(q)) && (!req.query.category || x.category === req.query.category))
        .map((x) => {
          const c = connectorFor(x.id);
          return {
            ...x,
            connection: byApp.get(x.id)?.status ?? null,
            mode: byApp.get(x.id)?.mode ?? null,
            auth: {
              oauth: !!c?.oauth,
              oauthConfigured: oauthConfigured(x.id),
              oauthNeeds: c?.oauth?.needs ?? [],
              apiKey: c?.apiKey ? { fields: c.apiKey.fields, help: c.apiKey.help } : null,
              live: !!c || SYSTEM_APPS.has(x.id),
            },
          };
        }),
    };
  });

  app.get("/connections", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => {
    const rows = await db.select().from(connections).where(eq(connections.workspaceId, auth(req).workspaceId)).orderBy(asc(connections.createdAt));
    return { data: rows.map(serializeConnection) };
  });

  /**
   * Connect (or reconnect) an app with API-key style credentials (validated against the app's
   * spec and tested live), or without credentials to use the demo driver. OAuth apps use
   * `POST /connections/:appId/authorize` instead. Runs waiting on the app resume automatically.
   */
  app.post("/connections", { preHandler: app.authorize("connections:write"), schema: { tags, body: z.object({ appId: z.string(), scope: scope.default("workspace"), credentials, sharedWith: z.array(z.string()).max(50).optional() }) } }, async (req, reply) => {
    const a = auth(req);
    if (!appById[req.body.appId]) throw badRequest(`Unknown app ${req.body.appId}`);
    const creds = req.body.credentials && Object.keys(req.body.credentials).length ? apiKeyCredentials(req.body.appId, req.body.credentials) : null;
    const row = await saveConnection({ workspaceId: a.workspaceId, appId: req.body.appId, scope: req.body.scope, userId: a.userId, userName: a.userName, sharedWith: req.body.sharedWith, credentials: creds, ip: req.ip });
    return reply.status(201).send(serializeConnection(row));
  });

  /** Start OAuth: returns the provider URL to send the browser to. */
  app.post(
    "/connections/:appId/authorize",
    { preHandler: app.authorize("connections:write"), schema: { tags, params: z.object({ appId: z.string() }), body: z.object({ scope: scope.default("workspace"), returnTo: z.string().max(500).default("/integrations"), extra: z.record(z.string(), z.string().max(300)).default({}) }) } },
    async (req) => {
      const a = auth(req);
      if (!a.userId) throw badRequest("Connect apps from a signed-in session");
      const returnTo = req.body.returnTo.startsWith("/") && !req.body.returnTo.startsWith("//") ? req.body.returnTo : "/integrations";
      try {
        return { url: await authorizeUrl({ workspaceId: a.workspaceId, userId: a.userId, userName: a.userName, appId: req.params.appId, scope: req.body.scope, returnTo, extra: req.body.extra }) };
      } catch (e) {
        if (e instanceof ConnectorError) throw badRequest(e.message);
        throw e;
      }
    },
  );

  /** OAuth redirect target (public): exchange the code, save the connection, send the user back to the app. */
  app.get("/oauth/callback", { schema: { hide: true, security: [], querystring: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional(), shop: z.string().optional() }) } }, async (req, reply) => {
    const back = (path: string, params: Record<string, string>) => reply.redirect(`${config.WEB_URL}${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams(params)}`);
    let state: ConnectState | null = null;
    try {
      if (!req.query.state) throw new ConnectorError("Missing state");
      state = await readState(req.query.state);
      if (req.query.error || !req.query.code) throw new ConnectorError(req.query.error_description ?? req.query.error ?? "Authorization was cancelled");
      const creds = await exchangeCode(state, req.query.code);
      // The user may have left the workspace while on the provider's consent screen.
      const [m] = await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.workspaceId, state.workspaceId), eq(memberships.userId, state.userId), eq(memberships.status, "active")));
      if (!m || !can(m.role, "connections:write")) throw new ConnectorError("You no longer have permission to connect apps in this workspace");
      await saveConnection({ workspaceId: state.workspaceId, appId: state.appId, scope: state.scope, userId: state.userId, userName: state.userName, credentials: creds, ip: req.ip });
      return back(state.returnTo, { connected: state.appId });
    } catch (e) {
      req.log.warn({ err: e }, "oauth callback failed");
      return back(state?.returnTo ?? "/integrations", { connect_error: (e as Error).message.slice(0, 200), app: state?.appId ?? "" });
    }
  });

  app.patch("/connections/:appId", { preHandler: app.authorize("connections:write"), schema: { tags, params: z.object({ appId: z.string() }), body: z.object({ scope: scope.optional(), sharedWith: z.array(z.string()).max(50).optional(), status: z.enum(["healthy", "expired", "error"]).optional() }) } }, async (req) => {
    const a = auth(req);
    const [row] = await db.update(connections).set(req.body).where(and(eq(connections.workspaceId, a.workspaceId), eq(connections.appId, req.params.appId))).returning();
    assertFound(row, "Connection");
    await publish({ workspaceId: a.workspaceId, type: "connection.updated", data: serializeConnection(row) });
    if (row.status === "healthy") await resumeRunsWaitingForApp(a.workspaceId, row.appId);
    return serializeConnection(row);
  });

  /** Re-check stored credentials against the app (refreshing OAuth tokens if needed). */
  app.post("/connections/:appId/test", { preHandler: app.authorize("connections:write"), schema: { tags, params: z.object({ appId: z.string() }) } }, async (req) => {
    const r = assertFound(await retestConnection(auth(req).workspaceId, req.params.appId), "Connection");
    return { ok: r.ok, mode: r.row.mode, detail: r.detail, connection: serializeConnection(r.row) };
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
