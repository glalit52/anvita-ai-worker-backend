import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { channelEndpoints, workers } from "../db/schema.js";
import { assertFound, badRequest, notFound, unauthorized } from "../lib/errors.js";
import { auth } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { routeInbound } from "../channels/common.js";
import { createEndpoint, endpointByKey, endpointSecrets, endpointWorker, listEndpoints, serializeEndpoint, updateEndpoint, type Endpoint } from "../channels/endpoints.js";
import { handleInboundEmail, parseInbound } from "../channels/email.js";
import { handleTeamsActivity, verifyTeamsRequest, type TeamsActivity } from "../channels/teams.js";
import { VOICE_PROVIDERS, voiceTurn } from "../channels/voice.js";
import { originAllowed, readVisitor, visitorMessages, visitorToken, widgetRef } from "../channels/widget.js";
import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";

const kind = z.enum(["widget", "email", "voice", "teams"]);
const cfg = z.record(z.string(), z.unknown());
const secrets = z.record(z.string(), z.string().max(2000));

function validate(k: Endpoint["kind"], c: Record<string, unknown>, s: Record<string, string>, existing?: Endpoint) {
  const have = { ...(existing ? endpointSecrets(existing) : {}), ...s };
  if (k === "email" && c.address !== undefined && !z.string().email().safeParse(String(c.address).replace(/^.*<|>$/g, "")).success) throw badRequest("Set the address customers write to, e.g. support@yourcompany.in");
  if (k === "email" && !existing && !c.address) throw badRequest("Set the address customers write to, e.g. support@yourcompany.in");
  if (k === "voice") {
    const p = String(c.provider ?? existing?.config.provider ?? "twilio");
    if (!VOICE_PROVIDERS[p]) throw badRequest(`Unknown voice provider "${p}". Available: ${Object.keys(VOICE_PROVIDERS).join(", ")}`);
    if (!have.authToken) throw badRequest("Add the provider's auth token so calls can be verified");
  }
  if (k === "teams") {
    if (!(c.botAppId ?? existing?.config.botAppId)) throw badRequest("Add the Azure Bot's Microsoft App ID");
    if (!have.botPassword) throw badRequest("Add the Azure Bot's client secret");
  }
  if (k === "widget" && c.allowedOrigins !== undefined && !Array.isArray(c.allowedOrigins)) throw badRequest("allowedOrigins must be a list");
}

export const channelEndpointRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ["channels"];
  const idParam = z.object({ id: z.string() });
  const load = async (workspaceId: string, id: string) => assertFound((await db.select().from(channelEndpoints).where(and(eq(channelEndpoints.id, id), eq(channelEndpoints.workspaceId, workspaceId))))[0], "Channel");
  const checkWorker = async (workspaceId: string, workerId: string | null | undefined) => {
    if (!workerId) return;
    const [w] = await db.select({ id: workers.id }).from(workers).where(and(eq(workers.id, workerId), eq(workers.workspaceId, workspaceId)));
    if (!w) throw badRequest("That Worker doesn't exist in this workspace");
  };

  app.get("/channel-endpoints", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => ({ data: (await listEndpoints(auth(req).workspaceId)).map(serializeEndpoint), voiceProviders: Object.values(VOICE_PROVIDERS).map((p) => ({ id: p.id, label: p.label })) }));

  app.post("/channel-endpoints", { preHandler: app.authorize("connections:write"), schema: { tags, body: z.object({ kind, name: z.string().trim().min(1).max(100), workerId: z.string().nullable().optional(), config: cfg.default({}), secrets: secrets.default({}) }) } }, async (req, reply) => {
    const a = auth(req);
    validate(req.body.kind, req.body.config, req.body.secrets);
    await checkWorker(a.workspaceId, req.body.workerId);
    const row = await createEndpoint(a.workspaceId, { ...req.body, createdBy: a.userName });
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "channel.created", target: `${req.body.kind} · ${req.body.name}`, ip: req.ip });
    return reply.status(201).send(serializeEndpoint(row));
  });

  app.patch("/channel-endpoints/:id", { preHandler: app.authorize("connections:write"), schema: { tags, params: idParam, body: z.object({ name: z.string().trim().min(1).max(100).optional(), workerId: z.string().nullable().optional(), enabled: z.boolean().optional(), config: cfg.optional(), secrets: secrets.optional() }) } }, async (req) => {
    const a = auth(req);
    const e = await load(a.workspaceId, req.params.id);
    validate(e.kind, req.body.config ?? {}, req.body.secrets ?? {}, e);
    await checkWorker(a.workspaceId, req.body.workerId);
    const row = await updateEndpoint(e, req.body);
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "channel.updated", target: `${e.kind} · ${row.name}`, ip: req.ip });
    return serializeEndpoint(row);
  });

  app.delete("/channel-endpoints/:id", { preHandler: app.authorize("connections:write"), schema: { tags, params: idParam } }, async (req, reply) => {
    const a = auth(req);
    const e = await load(a.workspaceId, req.params.id);
    await db.delete(channelEndpoints).where(eq(channelEndpoints.id, e.id));
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "channel.deleted", target: `${e.kind} · ${e.name}`, ip: req.ip });
    return reply.status(204).send();
  });
};

/** Public, unauthenticated routes: the website widget API and provider webhooks. */
export const channelPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  // ─── Website widget ───
  const widget = async (key: string, origin: string | undefined) => {
    const e = await endpointByKey(key, "widget");
    if (!e) throw notFound("Widget");
    if (!originAllowed(e, origin)) throw unauthorized("This widget isn't enabled for this website");
    return e;
  };
  const keyParam = z.object({ key: z.string().max(100) });
  const limited = { rateLimit: { max: 60, timeWindow: "1 minute" } };

  app.get("/public/widget/:key", { schema: { hide: true, params: keyParam } }, async (req) => {
    const e = await widget(req.params.key, req.headers.origin);
    const c = e.config as { title?: string; greeting?: string; color?: string; position?: string };
    const w = await endpointWorker(e);
    return { name: e.name, title: c.title ?? e.name, greeting: c.greeting ?? `Hi! I'm ${w?.name ?? "the assistant"}. How can I help?`, color: c.color ?? "#5B4CF0", position: c.position === "left" ? "left" : "right" };
  });

  app.post("/public/widget/:key/session", { schema: { hide: true, params: keyParam }, config: limited }, async (req) => {
    const e = await widget(req.params.key, req.headers.origin);
    return visitorToken(e);
  });

  app.post("/public/widget/:key/messages", { schema: { hide: true, params: keyParam, body: z.object({ text: z.string().trim().min(1).max(2000), name: z.string().trim().max(80).optional() }) }, config: limited }, async (req, reply) => {
    const e = await widget(req.params.key, req.headers.origin);
    const visitor = await readVisitor(e, req.headers.authorization);
    if (!visitor) throw unauthorized("Start a chat session first");
    const w = await endpointWorker(e);
    const who = req.body.name || "Website visitor";
    const r = await routeInbound({ workspaceId: e.workspaceId, ref: widgetRef(e, visitor), title: `${who} · ${e.name}`, channel: "widget", channelLabel: `Website · ${e.name}`, workerId: w?.id, author: who, text: req.body.text, trigger: "Website chat" });
    return reply.status(202).send({ accepted: true, handedOff: r.handedOff });
  });

  app.get("/public/widget/:key/messages", { schema: { hide: true, params: keyParam, querystring: z.object({ after: z.string().datetime().optional() }) } }, async (req) => {
    const e = await widget(req.params.key, req.headers.origin);
    const visitor = await readVisitor(e, req.headers.authorization);
    if (!visitor) throw unauthorized("Start a chat session first");
    return visitorMessages(e, visitor, req.query.after);
  });

  // ─── Inbound email ───
  app.post("/hooks/email/:key/:secret", { schema: { hide: true, params: z.object({ key: z.string(), secret: z.string() }) }, config: { rateLimit: false } }, async (req, reply) => {
    const e = await endpointByKey(req.params.key, "email");
    if (!e || !safeEqual(req.params.secret, endpointSecrets(e).webhook ?? "")) return reply.status(404).send({ error: { code: "not_found", message: "Unknown mailbox" } });
    let body = (req.body ?? {}) as Record<string, unknown>;
    if (req.isMultipart()) {
      body = {};
      for await (const part of req.parts()) if (part.type === "field") body[part.fieldname] = part.value;
    }
    const mail = parseInbound(body);
    if (!mail) return reply.status(400).send({ error: { code: "bad_request", message: "No sender in the payload" } });
    return handleInboundEmail(e, mail);
  });

  // ─── Voice ───
  app.post("/hooks/voice/:key/:step", { schema: { hide: true, params: z.object({ key: z.string(), step: z.enum(["incoming", "turn", "wait"]) }), querystring: z.object({ run: z.string().optional() }) }, config: { rateLimit: false } }, async (req, reply) => {
    const e = await endpointByKey(req.params.key, "voice");
    if (!e) return reply.status(404).send("Unknown number");
    const provider = VOICE_PROVIDERS[String(e.config.provider ?? "twilio")];
    const params = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    if (!provider.verify({ url: `${config.PUBLIC_URL}${req.url}`, params, headers: req.headers, secrets: endpointSecrets(e) })) return reply.status(401).send("Bad signature");
    const out = provider.render(await voiceTurn(e, req.params.step, provider.parse(params), req.query));
    return reply.type(out.contentType).send(out.body);
  });

  // ─── Microsoft Teams ───
  app.post("/hooks/teams/:key", { schema: { hide: true, params: z.object({ key: z.string() }) }, config: { rateLimit: false } }, async (req, reply) => {
    const e = await endpointByKey(req.params.key, "teams");
    if (!e) return reply.status(404).send();
    const activity = req.body as TeamsActivity;
    if (!activity?.serviceUrl || !activity.conversation?.id || !activity.from?.id) return reply.status(400).send();
    if (!(await verifyTeamsRequest(e, req.headers.authorization, activity))) return reply.status(401).send();
    await handleTeamsActivity(e, activity);
    return reply.status(200).send();
  });
};
