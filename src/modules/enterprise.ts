import { and, arrayOverlaps, asc, count, eq, ne, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { memberships, refreshTokens, ssoConfigs, users, workspaces } from "../db/schema.js";
import { sha256 } from "../lib/crypto.js";
import { AppError, badRequest, conflict } from "../lib/errors.js";
import { newId, randomString } from "../lib/ids.js";
import { assertPublicUrl } from "../lib/net.js";
import { auth } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import type { Role } from "../db/schema.js";
import { acsUrl, normaliseCerts, samlFinish, samlLoginUrl, samlMetadata, samlStartUrl, spEntityId, ssoConfigFor, ssoForEmail, type SsoConfig } from "../services/saml.js";
import { issueTokens } from "./auth.js";

const CONSUMER = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com", "rediffmail.com", "aol.com"]);
const ROLES = ["owner", "admin", "builder", "member", "viewer"] as const;
const scimBase = () => `${config.PUBLIC_URL}/v1/scim/v2`;

function serializeSso(c: SsoConfig | null, workspaceId: string) {
  return {
    enabled: c?.enabled ?? false,
    entryPoint: c?.entryPoint ?? null,
    idpIssuer: c?.idpIssuer ?? null,
    hasCertificate: !!c?.idpCert,
    domains: c?.domains ?? [],
    enforced: c?.enforced ?? false,
    allowJit: c?.allowJit ?? true,
    defaultRole: c?.defaultRole ?? "member",
    sp: { entityId: spEntityId(workspaceId), acsUrl: acsUrl(workspaceId), metadataUrl: spEntityId(workspaceId), loginUrl: samlLoginUrl(workspaceId) },
    scim: { baseUrl: scimBase(), tokenHint: c?.scimTokenHint ?? null },
  };
}

/** Sign a person in after SSO: activate invites, create the member (JIT) if allowed, issue tokens. */
async function completeSamlLogin(cfg: SsoConfig, id: { email: string; name: string }, userAgent?: string) {
  let [u] = await db.select().from(users).where(eq(users.email, id.email));
  const [m] = await db.select().from(memberships).where(and(eq(memberships.workspaceId, cfg.workspaceId), sql`lower(${memberships.email}) = ${id.email}`));
  if (m?.status === "suspended") throw badRequest("Your access to this workspace was removed by your administrator");
  if (!m && !cfg.allowJit) throw badRequest("You haven't been given access to this workspace yet — ask your administrator");
  if (!u) [u] = await db.insert(users).values({ id: newId("usr"), email: id.email, name: id.name, lastActiveAt: new Date() }).returning();
  if (!m) await db.insert(memberships).values({ id: newId("mem"), workspaceId: cfg.workspaceId, userId: u.id, email: id.email, name: id.name, role: cfg.defaultRole, status: "active", sso: true, lastActiveAt: new Date() });
  else await db.update(memberships).set({ userId: u.id, status: "active", sso: true, inviteTokenHash: null, lastActiveAt: new Date() }).where(eq(memberships.id, m.id));
  await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, u.id));
  await audit({ workspaceId: cfg.workspaceId, actor: id.name, actorId: u.id, action: "auth.saml_login", target: id.email, payload: { jit: !m } });
  return issueTokens(u.id, userAgent);
}

export const enterpriseRoutes: FastifyPluginAsyncZod = async (app) => {
  // SAML POST binding and SCIM bodies.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
  app.addContentTypeParser("application/scim+json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(String(body)) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  const tags = ["sso"];
  const wsParam = z.object({ workspaceId: z.string() });

  // ─── SAML (public) ───

  app.get("/auth/saml/:workspaceId/metadata", { schema: { tags, security: [], params: wsParam } }, async (req, reply) => {
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, req.params.workspaceId));
    if (!ws) throw badRequest("Unknown workspace");
    reply.header("content-type", "application/samlmetadata+xml; charset=utf-8");
    return samlMetadata(ws.id);
  });

  app.get("/auth/saml/:workspaceId/login", { schema: { tags, security: [], params: wsParam, querystring: z.object({ redirect: z.string().max(500).optional() }) } }, async (req, reply) => {
    const cfg = await ssoConfigFor(req.params.workspaceId);
    if (!cfg?.enabled) return reply.redirect(`${config.WEB_URL}/login?sso_error=${encodeURIComponent("Single sign-on isn't enabled for this workspace")}`);
    const redirect = req.query.redirect?.startsWith("/") ? req.query.redirect : "/home";
    return reply.redirect(await samlStartUrl(cfg, redirect));
  });

  /** Assertion consumer service: the IdP POSTs the signed response here (SP- or IdP-initiated). */
  app.post("/auth/saml/:workspaceId/acs", { schema: { tags, security: [], hide: true, params: wsParam, body: z.object({ SAMLResponse: z.string().max(1_500_000).optional(), RelayState: z.string().max(4000).optional() }) } }, async (req, reply) => {
    const fail = (msg: string) => reply.redirect(`${config.WEB_URL}/login?sso_error=${encodeURIComponent(msg.slice(0, 200))}`);
    try {
      const cfg = await ssoConfigFor(req.params.workspaceId);
      if (!cfg?.enabled) return fail("Single sign-on isn't enabled for this workspace");
      const id = await samlFinish(cfg, req.body);
      const t = await completeSamlLogin(cfg, id, req.headers["user-agent"]);
      const frag = new URLSearchParams({ access_token: t.accessToken, refresh_token: t.refreshToken, workspace_id: cfg.workspaceId, redirect: id.redirect });
      return reply.redirect(`${config.WEB_URL}/auth/callback#${frag}`);
    } catch (e) {
      req.log.warn({ err: e }, "saml login failed");
      return fail((e as Error).message);
    }
  });

  /** Login page helper: does this email belong to an SSO workspace? */
  app.get("/auth/sso/discover", { schema: { tags, security: [], querystring: z.object({ email: z.string().trim().toLowerCase().email() }) } }, async (req) => {
    const cfg = await ssoForEmail(req.query.email);
    return cfg ? { method: "saml" as const, enforced: cfg.enforced, loginUrl: samlLoginUrl(cfg.workspaceId) } : { method: "password" as const, enforced: false, loginUrl: null };
  });

  // ─── SSO settings (admins) ───

  app.get("/workspace/sso", { preHandler: app.authorize("workspace:manage"), schema: { tags } }, async (req) => {
    const a = auth(req);
    return serializeSso(await ssoConfigFor(a.workspaceId), a.workspaceId);
  });

  app.put(
    "/workspace/sso",
    {
      preHandler: app.authorize("workspace:manage"),
      schema: {
        tags,
        body: z.object({
          enabled: z.boolean().optional(),
          entryPoint: z.string().url().nullable().optional(),
          idpIssuer: z.string().max(500).nullable().optional(),
          idpCert: z.string().max(20_000).nullable().optional(),
          domains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Use a domain like kesarfoods.in")).max(20).optional(),
          enforced: z.boolean().optional(),
          allowJit: z.boolean().optional(),
          defaultRole: z.enum(["admin", "builder", "member", "viewer"]).optional(),
        }),
      },
    },
    async (req) => {
      const a = auth(req);
      const cur = await ssoConfigFor(a.workspaceId);
      const b = req.body;
      if (b.entryPoint) await assertPublicUrl(b.entryPoint);
      const idpCert = b.idpCert === undefined ? cur?.idpCert ?? null : b.idpCert ? normaliseCerts(b.idpCert).join("\n") : null;
      const domains = b.domains ?? cur?.domains ?? [];
      for (const d of domains) if (CONSUMER.has(d)) throw badRequest(`${d} is a public email domain and can't be routed to your IdP`);
      if (domains.length) {
        const [taken] = await db.select({ ws: ssoConfigs.workspaceId }).from(ssoConfigs).where(and(ne(ssoConfigs.workspaceId, a.workspaceId), arrayOverlaps(ssoConfigs.domains, domains)));
        if (taken) throw conflict("One of these domains is already claimed by another workspace");
      }
      const next = { enabled: b.enabled ?? cur?.enabled ?? false, entryPoint: b.entryPoint === undefined ? cur?.entryPoint ?? null : b.entryPoint, idpIssuer: b.idpIssuer === undefined ? cur?.idpIssuer ?? null : b.idpIssuer, idpCert, domains, enforced: b.enforced ?? cur?.enforced ?? false, allowJit: b.allowJit ?? cur?.allowJit ?? true, defaultRole: (b.defaultRole ?? cur?.defaultRole ?? "member") as Role, updatedAt: new Date() };
      if (next.enabled && (!next.entryPoint || !next.idpCert)) throw badRequest("Add the IdP sign-on URL and certificate before enabling SSO");
      if (next.enforced && (!next.enabled || !domains.length)) throw badRequest("Enforcing SSO needs SSO enabled and at least one domain");
      const [row] = await db.insert(ssoConfigs).values({ workspaceId: a.workspaceId, ...next }).onConflictDoUpdate({ target: ssoConfigs.workspaceId, set: next }).returning();
      await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "sso.updated", target: `SAML ${row.enabled ? "on" : "off"}${row.enforced ? " (enforced)" : ""}`, ip: req.ip, payload: { domains: row.domains } });
      return serializeSso(row, a.workspaceId);
    },
  );

  /** Read IdP metadata (pasted XML or URL) into the fields above. Doesn't save. */
  app.post("/workspace/sso/parse-metadata", { preHandler: app.authorize("workspace:manage"), schema: { tags, body: z.object({ xml: z.string().max(500_000).optional(), url: z.string().url().optional() }) } }, async (req) => {
    let xml = req.body.xml;
    if (!xml && req.body.url) {
      const res = await fetch(await assertPublicUrl(req.body.url), { signal: AbortSignal.timeout(15_000), redirect: "follow" });
      if (!res.ok) throw badRequest(`Couldn't download the metadata (HTTP ${res.status})`);
      xml = await res.text();
    }
    if (!xml) throw badRequest("Paste the metadata XML or its URL");
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true }).parse(xml);
    const ed = doc.EntityDescriptor ?? doc.EntitiesDescriptor?.EntityDescriptor;
    const idp = (Array.isArray(ed) ? ed[0] : ed)?.IDPSSODescriptor;
    if (!idp) throw badRequest("No IdP descriptor found in this metadata");
    const sso = ([] as { "@Binding": string; "@Location": string }[]).concat(idp.SingleSignOnService ?? []);
    const entryPoint = (sso.find((x) => x["@Binding"]?.endsWith("HTTP-Redirect")) ?? sso[0])?.["@Location"] ?? null;
    const keys = ([] as { "@use"?: string; KeyInfo?: { X509Data?: { X509Certificate?: string | { "#text": string } } } }[]).concat(idp.KeyDescriptor ?? []);
    const certs = keys.filter((k) => !k["@use"] || k["@use"] === "signing").map((k) => k.KeyInfo?.X509Data?.X509Certificate).map((c) => (typeof c === "object" ? c?.["#text"] : c)).filter(Boolean) as string[];
    return { entryPoint, idpIssuer: (Array.isArray(ed) ? ed[0] : ed)?.["@entityID"] ?? null, idpCert: certs.length ? normaliseCerts(certs.join("\n")).join("\n") : null };
  });

  app.post("/workspace/scim-token", { preHandler: app.authorize("workspace:manage"), schema: { tags } }, async (req, reply) => {
    const a = auth(req);
    const token = `scim_${randomString(40)}`;
    const values = { scimTokenHash: sha256(token), scimTokenHint: token.slice(-4), updatedAt: new Date() };
    await db.insert(ssoConfigs).values({ workspaceId: a.workspaceId, ...values }).onConflictDoUpdate({ target: ssoConfigs.workspaceId, set: values });
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "scim.token_created", target: `…${values.scimTokenHint}`, ip: req.ip });
    return reply.status(201).send({ token, baseUrl: scimBase(), hint: values.scimTokenHint });
  });

  app.delete("/workspace/scim-token", { preHandler: app.authorize("workspace:manage"), schema: { tags } }, async (req, reply) => {
    const a = auth(req);
    await db.update(ssoConfigs).set({ scimTokenHash: null, scimTokenHint: null }).where(eq(ssoConfigs.workspaceId, a.workspaceId));
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "scim.token_revoked", target: "SCIM", ip: req.ip });
    return reply.status(204).send();
  });

  await app.register(scimRoutes, { prefix: "/scim/v2" });
};

// ─── SCIM 2.0 (RFC 7643/7644) ──────────────────────────────────────────────────

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

class ScimError extends AppError {
  constructor(status: number, detail: string, scimType?: string) {
    super(status, "scim_error", detail, { scimType });
  }
}

type Member = typeof memberships.$inferSelect;

function scimUser(m: Member) {
  const [given, ...rest] = m.name.split(" ");
  return {
    schemas: [USER],
    id: m.id,
    externalId: m.externalId ?? undefined,
    userName: m.email,
    name: { formatted: m.name, givenName: given, familyName: rest.join(" ") || undefined },
    displayName: m.name,
    emails: [{ value: m.email, type: "work", primary: true }],
    active: m.status === "active" || m.status === "invited",
    roles: [{ value: m.role, primary: true }],
    meta: { resourceType: "User", created: m.createdAt.toISOString(), lastModified: (m.lastActiveAt ?? m.createdAt).toISOString(), location: `${scimBase()}/Users/${m.id}` },
  };
}

const roleGroup = (workspaceId: string, role: Role, members: Member[]) => ({
  schemas: [GROUP],
  id: `role-${role}`,
  displayName: `Anvita ${role[0].toUpperCase()}${role.slice(1)}s`,
  members: members.filter((m) => m.role === role).map((m) => ({ value: m.id, display: m.email })),
  meta: { resourceType: "Group", location: `${scimBase()}/Groups/role-${role}`, version: `W/"${workspaceId}-${role}"` },
});

/** "Anvita Admins", "admins", "Builder" → admin / builder … */
function roleFromGroupName(name: string): Role | null {
  const n = name.toLowerCase();
  return (["admin", "builder", "viewer", "member"] as const).find((r) => n.includes(r)) ?? null;
}

function nameFrom(body: Record<string, any>, fallback: string) {
  const n = body.name ?? {};
  return String(n.formatted ?? ([n.givenName, n.familyName].filter(Boolean).join(" ") || body.displayName || fallback)).slice(0, 100);
}

function emailFrom(body: Record<string, any>) {
  const primary = (body.emails as { value: string; primary?: boolean }[] | undefined)?.find((e) => e.primary) ?? body.emails?.[0];
  return String(primary?.value ?? body.userName ?? "").trim().toLowerCase();
}

const scimRoutes: FastifyPluginAsyncZod = async (app) => {
  // Bearer token → workspace. Every SCIM query is scoped to that workspace.
  app.decorateRequest("scimWorkspace", "");
  app.addHook("onRequest", async (req) => {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
    if (!token) throw new ScimError(401, "Missing bearer token");
    const [cfg] = await db.select({ ws: ssoConfigs.workspaceId }).from(ssoConfigs).where(eq(ssoConfigs.scimTokenHash, sha256(token)));
    if (!cfg) throw new ScimError(401, "Invalid SCIM token");
    (req as unknown as { scimWorkspace: string }).scimWorkspace = cfg.ws;
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("content-type", "application/scim+json; charset=utf-8");
    return payload;
  });
  app.setErrorHandler((err: Error & { statusCode?: number; details?: { scimType?: string } }, _req, reply) => {
    const status = err.statusCode ?? 500;
    return reply.status(status).send({ schemas: [ERROR], status: String(status), detail: status >= 500 ? "Internal error" : err.message, ...(err.details?.scimType ? { scimType: err.details.scimType } : {}) });
  });

  const ws = (req: unknown) => (req as { scimWorkspace: string }).scimWorkspace;
  const load = async (workspaceId: string, id: string) => {
    const [m] = await db.select().from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, id)));
    if (!m) throw new ScimError(404, `User ${id} not found`);
    return m;
  };
  const audited = (workspaceId: string, action: string, target: string) => audit({ workspaceId, actor: "SCIM", actorType: "system", action, target });

  app.get("/ServiceProviderConfig", async () => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "Token from Anvita → Settings → Security → SCIM", primary: true }],
  }));
  app.get("/ResourceTypes", async () => ({
    schemas: [LIST],
    totalResults: 2,
    Resources: [
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER },
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP },
    ],
  }));
  app.get("/Schemas", async () => ({ schemas: [LIST], totalResults: 2, Resources: [{ id: USER, name: "User" }, { id: GROUP, name: "Group" }] }));

  app.get("/Users", { schema: { querystring: z.object({ filter: z.string().max(500).optional(), startIndex: z.coerce.number().int().min(1).default(1), count: z.coerce.number().int().min(0).max(200).default(100) }) } }, async (req) => {
    const w = ws(req);
    const conds = [eq(memberships.workspaceId, w)];
    if (req.query.filter) {
      // Okta / Entra send: userName eq "a@b.com", externalId eq "…", emails[type eq "work"].value eq "…"
      const m = /^\s*(userName|externalId|emails(?:\[type eq "work"\])?\.value|id)\s+eq\s+"([^"]*)"\s*$/i.exec(req.query.filter);
      if (!m) throw new ScimError(400, `Unsupported filter: ${req.query.filter}`, "invalidFilter");
      const [field, value] = [m[1].toLowerCase(), m[2]];
      if (field === "externalid") conds.push(eq(memberships.externalId, value));
      else if (field === "id") conds.push(eq(memberships.id, value));
      else conds.push(sql`lower(${memberships.email}) = ${value.toLowerCase()}`);
    }
    const [{ total }] = await db.select({ total: count() }).from(memberships).where(and(...conds));
    const rows = await db.select().from(memberships).where(and(...conds)).orderBy(asc(memberships.createdAt)).offset(req.query.startIndex - 1).limit(req.query.count);
    return { schemas: [LIST], totalResults: total, startIndex: req.query.startIndex, itemsPerPage: rows.length, Resources: rows.map(scimUser) };
  });

  app.get("/Users/:id", { schema: { params: z.object({ id: z.string() }) } }, async (req) => scimUser(await load(ws(req), req.params.id)));

  app.post("/Users", async (req, reply) => {
    const w = ws(req);
    const body = (req.body ?? {}) as Record<string, any>;
    const email = emailFrom(body);
    if (!email.includes("@")) throw new ScimError(400, "userName or emails[].value must be an email address", "invalidValue");
    const [dup] = await db.select().from(memberships).where(and(eq(memberships.workspaceId, w), sql`lower(${memberships.email}) = ${email}`));
    if (dup && dup.status !== "suspended") throw new ScimError(409, `${email} already exists`, "uniqueness");
    const name = nameFrom(body, email.split("@")[0]);
    const [cfg] = await db.select().from(ssoConfigs).where(eq(ssoConfigs.workspaceId, w));
    const [u] = await db.select().from(users).where(eq(users.email, email));
    const active = body.active !== false;
    const values = { name, email, externalId: body.externalId ? String(body.externalId) : null, userId: u?.id ?? null, status: (active ? (u ? "active" : "invited") : "suspended") as Member["status"], sso: true };
    const [m] = dup
      ? await db.update(memberships).set(values).where(eq(memberships.id, dup.id)).returning()
      : await db.insert(memberships).values({ id: newId("mem"), workspaceId: w, role: (cfg?.defaultRole ?? "member") as Role, ...values }).returning();
    await audited(w, "scim.user_provisioned", email);
    return reply.status(201).send(scimUser(m));
  });

  const applyActive = async (m: Member, active: boolean) => {
    if (active) return m.userId ? "active" : "invited";
    if (m.role === "owner") throw new ScimError(400, "Workspace owners can't be deprovisioned through SCIM", "mutability");
    // Deprovisioned people lose access immediately; sessions die if this was their last workspace.
    if (m.userId) {
      const [{ others }] = await db.select({ others: count() }).from(memberships).where(and(eq(memberships.userId, m.userId), eq(memberships.status, "active"), ne(memberships.id, m.id)));
      if (!others) await db.delete(refreshTokens).where(eq(refreshTokens.userId, m.userId));
    }
    return "suspended";
  };

  app.put("/Users/:id", { schema: { params: z.object({ id: z.string() }) } }, async (req) => {
    const w = ws(req);
    const m = await load(w, req.params.id);
    const body = (req.body ?? {}) as Record<string, any>;
    const status = await applyActive(m, body.active !== false);
    const email = emailFrom(body) || m.email;
    const [u] = await db.update(memberships).set({ name: nameFrom(body, m.name), email, externalId: body.externalId ? String(body.externalId) : m.externalId, status: status as Member["status"] }).where(eq(memberships.id, m.id)).returning();
    await audited(w, status === "suspended" ? "scim.user_deprovisioned" : "scim.user_updated", email);
    return scimUser(u);
  });

  app.patch("/Users/:id", { schema: { params: z.object({ id: z.string() }) } }, async (req) => {
    const w = ws(req);
    const m = await load(w, req.params.id);
    const body = (req.body ?? {}) as { schemas?: string[]; Operations?: { op: string; path?: string; value?: unknown }[] };
    if (!body.Operations?.length) throw new ScimError(400, "PatchOp needs Operations", "invalidSyntax");
    const patch: Partial<Member> = {};
    let active: boolean | null = null;
    for (const op of body.Operations) {
      if (!/^(replace|add)$/i.test(op.op)) continue;
      // Either { path: "active", value: false } or { value: { active: false, … } } (Entra style).
      const entries: [string, unknown][] = op.path ? [[op.path, op.value]] : Object.entries((op.value ?? {}) as Record<string, unknown>);
      for (const [path, value] of entries) {
        const p = path.toLowerCase();
        if (p === "active") active = value === true || value === "True" || value === "true";
        else if (p === "displayname" || p === "name.formatted") patch.name = String(value).slice(0, 100);
        else if (p === "name.givenname") patch.name = `${String(value)} ${m.name.split(" ").slice(1).join(" ")}`.trim();
        else if (p === "name.familyname") patch.name = `${m.name.split(" ")[0]} ${String(value)}`.trim();
        else if (p === "externalid") patch.externalId = String(value);
        else if (p === "username" || p.startsWith("emails")) patch.email = String(Array.isArray(value) ? (value[0] as { value: string }).value : value).toLowerCase();
      }
    }
    if (active !== null) patch.status = (await applyActive(m, active)) as Member["status"];
    const [u] = await db.update(memberships).set(patch).where(eq(memberships.id, m.id)).returning();
    await audited(w, patch.status === "suspended" ? "scim.user_deprovisioned" : "scim.user_updated", u.email);
    return scimUser(u);
  });

  app.delete("/Users/:id", { schema: { params: z.object({ id: z.string() }) } }, async (req, reply) => {
    const w = ws(req);
    const m = await load(w, req.params.id);
    await applyActive(m, false);
    await db.delete(memberships).where(eq(memberships.id, m.id));
    await audited(w, "scim.user_deleted", m.email);
    return reply.status(204).send();
  });

  // Groups are the workspace roles, so the IdP can manage who is an admin, builder, member or viewer.
  app.get("/Groups", async (req) => {
    const w = ws(req);
    const rows = await db.select().from(memberships).where(eq(memberships.workspaceId, w));
    const groups = ROLES.filter((r) => r !== "owner").map((r) => roleGroup(w, r, rows));
    const filter = (req.query as { filter?: string }).filter;
    const byName = filter ? /displayName\s+eq\s+"([^"]*)"/i.exec(filter)?.[1] : undefined;
    const list = byName ? groups.filter((g) => g.displayName.toLowerCase() === byName.toLowerCase() || roleFromGroupName(byName) === g.id.slice(5)) : groups;
    return { schemas: [LIST], totalResults: list.length, startIndex: 1, itemsPerPage: list.length, Resources: list };
  });

  const groupRole = (id: string): Role => {
    const r = id.replace(/^role-/, "") as Role;
    if (!ROLES.includes(r) || r === "owner") throw new ScimError(404, `Group ${id} not found`);
    return r;
  };

  app.get("/Groups/:id", { schema: { params: z.object({ id: z.string() }) } }, async (req) => {
    const w = ws(req);
    const role = groupRole(req.params.id);
    return roleGroup(w, role, await db.select().from(memberships).where(eq(memberships.workspaceId, w)));
  });

  /** Creating a group named like a role ("Anvita Admins") maps it onto that role. */
  app.post("/Groups", async (req, reply) => {
    const w = ws(req);
    const body = (req.body ?? {}) as { displayName?: string; members?: { value: string }[] };
    const role = roleFromGroupName(body.displayName ?? "");
    if (!role) throw new ScimError(400, "Group names must include a role: admin, builder, member or viewer", "invalidValue");
    for (const mem of body.members ?? []) await setRole(w, mem.value, role);
    return reply.status(201).send(roleGroup(w, role, await db.select().from(memberships).where(eq(memberships.workspaceId, w))));
  });

  const setRole = async (workspaceId: string, membershipId: string, role: Role) => {
    const m = await load(workspaceId, membershipId);
    if (m.role === "owner") return; // owners are managed in Anvita
    await db.update(memberships).set({ role }).where(eq(memberships.id, m.id));
    await audited(workspaceId, "scim.role_changed", `${m.email} → ${role}`);
  };

  app.patch("/Groups/:id", { schema: { params: z.object({ id: z.string() }) } }, async (req) => {
    const w = ws(req);
    const role = groupRole(req.params.id);
    const body = (req.body ?? {}) as { Operations?: { op: string; path?: string; value?: { value: string }[] | { members?: { value: string }[] } }[] };
    for (const op of body.Operations ?? []) {
      const members = Array.isArray(op.value) ? op.value : (op.value as { members?: { value: string }[] } | undefined)?.members ?? [];
      if (/^add$/i.test(op.op) || (/^replace$/i.test(op.op) && (op.path ?? "members") === "members")) for (const mem of members) await setRole(w, mem.value, role);
      if (/^remove$/i.test(op.op)) {
        // remove members[value eq "id"] → back to the workspace's default role
        const ids = members.length ? members.map((x) => x.value) : [/value eq "([^"]+)"/.exec(op.path ?? "")?.[1]].filter(Boolean) as string[];
        const [cfg] = await db.select().from(ssoConfigs).where(eq(ssoConfigs.workspaceId, w));
        for (const id of ids) await setRole(w, id, (cfg?.defaultRole ?? "member") as Role);
      }
    }
    return roleGroup(w, role, await db.select().from(memberships).where(eq(memberships.workspaceId, w)));
  });
};

export { PATCH as SCIM_PATCH_SCHEMA };
