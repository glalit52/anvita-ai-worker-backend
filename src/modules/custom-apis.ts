import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { operationsFromSpec, parseSpec } from "../connectors/openapi.js";
import { db } from "../db/client.js";
import { customApis, type ApiOperation } from "../db/schema.js";
import { encrypt } from "../lib/crypto.js";
import { assertFound, badRequest } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { assertPublicUrl } from "../lib/net.js";
import { auth } from "../plugins/auth.js";
import { callCustomApi } from "../runtime/tools/custom-api.js";
import { audit } from "../services/audit.js";

type Api = typeof customApis.$inferSelect;

export function serializeCustomApi(a: Api) {
  return {
    id: a.id,
    name: a.name,
    slug: a.slug,
    baseUrl: a.baseUrl,
    authType: a.authType,
    authName: a.authName,
    hasSecret: !!a.secretEnc,
    enabled: a.enabled,
    operations: a.operations.map((o) => ({ id: o.id, method: o.method, path: o.path, summary: o.summary, sideEffect: o.sideEffect, enabled: o.enabled, action: `api.${a.slug}.${o.id}`, params: o.params.map((p) => ({ name: p.name, in: p.in, required: p.required })), hasBody: !!o.body })),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "api";

async function fetchSpec(url: string): Promise<string> {
  const u = await assertPublicUrl(url);
  const res = await fetch(u, { headers: { Accept: "application/json, application/yaml, text/yaml, */*" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw badRequest(`Couldn't download the spec (HTTP ${res.status})`);
  const text = await res.text();
  if (text.length > 5_000_000) throw badRequest("The spec is larger than 5 MB");
  return text;
}

/**
 * Custom APIs: import an OpenAPI/Swagger spec (pasted or by URL) and every operation becomes a
 * tool for the agent and for workflow Tool steps (`api.<slug>.<operation>`). GETs are read-only;
 * everything else goes through approval policies like any other write.
 */
export const customApiRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ["integrations"];
  const idParam = z.object({ id: z.string() });
  const authFields = { authType: z.enum(["none", "bearer", "header", "query", "basic"]).optional(), authName: z.string().max(100).optional(), secret: z.string().max(4000).optional() };

  app.get("/custom-apis", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => {
    const rows = await db.select().from(customApis).where(eq(customApis.workspaceId, auth(req).workspaceId)).orderBy(asc(customApis.createdAt));
    return { data: rows.map(serializeCustomApi) };
  });

  /** Parse without saving, so the Studio can show operations before import. */
  app.post("/custom-apis/preview", { preHandler: app.authorize("connections:write"), schema: { tags, body: z.object({ spec: z.string().max(5_000_000).optional(), specUrl: z.string().url().optional() }) } }, async (req) => {
    if (!req.body.spec && !req.body.specUrl) throw badRequest("Paste a spec or give its URL");
    const parsed = operationsFromSpec(parseSpec(req.body.spec ?? (await fetchSpec(req.body.specUrl!))));
    return { title: parsed.title, baseUrl: parsed.baseUrl, auth: parsed.auth, operations: parsed.operations.map((o) => ({ id: o.id, method: o.method, path: o.path, summary: o.summary, sideEffect: o.sideEffect })) };
  });

  app.post(
    "/custom-apis",
    { preHandler: app.authorize("connections:write"), schema: { tags, body: z.object({ name: z.string().trim().min(1).max(100).optional(), spec: z.string().max(5_000_000).optional(), specUrl: z.string().url().optional(), baseUrl: z.string().url().optional(), ...authFields }) } },
    async (req, reply) => {
      const a = auth(req);
      if (!req.body.spec && !req.body.specUrl) throw badRequest("Paste a spec or give its URL");
      const parsed = operationsFromSpec(parseSpec(req.body.spec ?? (await fetchSpec(req.body.specUrl!))));
      if (!parsed.operations.length) throw badRequest("The spec has no operations");
      const baseUrl = req.body.baseUrl ?? (parsed.baseUrl && /^https?:\/\//.test(parsed.baseUrl) ? parsed.baseUrl : req.body.specUrl ? new URL(parsed.baseUrl ?? "/", req.body.specUrl).toString() : null);
      if (!baseUrl) throw badRequest("The spec has no server URL — set the base URL");
      await assertPublicUrl(baseUrl);
      const name = req.body.name ?? parsed.title;
      let slug = slugify(name);
      const taken = new Set((await db.select({ slug: customApis.slug }).from(customApis).where(eq(customApis.workspaceId, a.workspaceId))).map((r) => r.slug));
      for (let i = 2; taken.has(slug); i++) slug = `${slugify(name).slice(0, 20)}_${i}`;
      const authType = req.body.authType ?? parsed.auth.type;
      const [row] = await db
        .insert(customApis)
        .values({ id: newId("api"), workspaceId: a.workspaceId, name, slug, baseUrl: baseUrl.replace(/\/+$/, ""), authType, authName: req.body.authName ?? parsed.auth.name ?? null, secretEnc: req.body.secret ? encrypt(req.body.secret) : null, operations: parsed.operations, createdBy: a.userId })
        .returning();
      await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "custom_api.imported", target: `${name} (${parsed.operations.length} operations)`, ip: req.ip });
      return reply.status(201).send(serializeCustomApi(row));
    },
  );

  app.patch(
    "/custom-apis/:id",
    {
      preHandler: app.authorize("connections:write"),
      schema: { tags, params: idParam, body: z.object({ name: z.string().trim().min(1).max(100).optional(), baseUrl: z.string().url().optional(), enabled: z.boolean().optional(), ...authFields, operations: z.array(z.object({ id: z.string(), enabled: z.boolean().optional(), sideEffect: z.enum(["none", "write", "external", "destructive"]).optional() })).max(200).optional() }) },
    },
    async (req) => {
      const a = auth(req);
      const row = assertFound((await db.select().from(customApis).where(and(eq(customApis.id, req.params.id), eq(customApis.workspaceId, a.workspaceId))))[0], "API");
      if (req.body.baseUrl) await assertPublicUrl(req.body.baseUrl);
      const ops: ApiOperation[] = row.operations.map((o) => {
        const p = req.body.operations?.find((x) => x.id === o.id);
        return p ? { ...o, ...(p.enabled !== undefined ? { enabled: p.enabled } : {}), ...(p.sideEffect ? { sideEffect: p.sideEffect } : {}) } : o;
      });
      const [u] = await db
        .update(customApis)
        .set({ name: req.body.name, baseUrl: req.body.baseUrl?.replace(/\/+$/, ""), enabled: req.body.enabled, authType: req.body.authType, authName: req.body.authName, ...(req.body.secret !== undefined ? { secretEnc: req.body.secret ? encrypt(req.body.secret) : null } : {}), operations: ops, updatedAt: new Date() })
        .where(eq(customApis.id, row.id))
        .returning();
      await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "custom_api.updated", target: u.name, ip: req.ip });
      return serializeCustomApi(u);
    },
  );

  /** Try one operation with sample input (respects nothing but the API's own auth — admins only). */
  app.post("/custom-apis/:id/try", { preHandler: app.authorize("connections:write"), schema: { tags, params: idParam, body: z.object({ operationId: z.string(), input: z.record(z.string(), z.unknown()).default({}) }) } }, async (req) => {
    const a = auth(req);
    const row = assertFound((await db.select().from(customApis).where(and(eq(customApis.id, req.params.id), eq(customApis.workspaceId, a.workspaceId))))[0], "API");
    const op = row.operations.find((o) => o.id === req.body.operationId);
    if (!op) throw badRequest("Unknown operation");
    if (op.sideEffect !== "none") throw badRequest("Only read-only (GET) operations can be tried from here — run writes through a workflow so policies apply");
    try {
      return { ok: true, ...(await callCustomApi(row, op, req.body.input)) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  app.delete("/custom-apis/:id", { preHandler: app.authorize("connections:write"), schema: { tags, params: idParam } }, async (req, reply) => {
    const a = auth(req);
    const [row] = await db.delete(customApis).where(and(eq(customApis.id, req.params.id), eq(customApis.workspaceId, a.workspaceId))).returning();
    assertFound(row, "API");
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "custom_api.removed", target: row.name, ip: req.ip });
    return reply.status(204).send();
  });
};
