import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { kbDocuments, kbSources, knowledgeBases, memories, skills, workspaces } from "../db/schema.js";
import { assertFound, badRequest } from "../lib/errors.js";
import { CLIENT_ID_RE, newId } from "../lib/ids.js";
import { auth } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { ingestDocument, searchKnowledge } from "../services/knowledge.js";
import { serializeKb, serializeMemory, serializeSkill } from "../services/serializers.js";

/** Skill packs shipped with the product; installing one adds its skills to the workspace. */
export const SKILL_PACKS: Record<string, { name: string; description: string; tools: string[] }[]> = {
  "India Finance Pack (GST, TDS, e-invoice)": [
    { name: "GST reconciliation (GSTR-2B vs books)", description: "Match purchase register with GSTR-2B, flag mismatches by GSTIN and invoice.", tools: ["tally.vouchers.export"] },
    { name: "TDS deduction check", description: "Check vendor payments for applicable TDS sections and rates.", tools: ["tally.vouchers.export"] },
  ],
  "D2C Growth Pack": [
    { name: "Weekly ROAS & CAC review", description: "Pull ad spend and conversions, compute ROAS/CAC by channel and flag outliers.", tools: ["metaads.insights", "googleads.report", "ga4.report"] },
    { name: "RTO risk triage", description: "Score COD orders for RTO risk using pincode and history, confirm risky ones on WhatsApp.", tools: ["shopify.orders.search", "whatsapp.send"] },
  ],
  "HR & Payroll (PF, ESI)": [
    { name: "Payroll pre-check", description: "Check payroll inputs, PF/ESI applicability and leave balances before the run.", tools: [] },
  ],
  "Exports & Customs": [
    { name: "Shipping bill review", description: "Check shipping bills, IEC and RoDTEP claim eligibility.", tools: [] },
  ],
};

async function kbWithCounts(workspaceId: string, ids?: string[]) {
  const kbs = await db.select().from(knowledgeBases).where(and(eq(knowledgeBases.workspaceId, workspaceId), ...(ids ? [inArray(knowledgeBases.id, ids)] : []))).orderBy(asc(knowledgeBases.createdAt));
  if (!kbs.length) return [];
  const kbIds = kbs.map((k) => k.id);
  const sources = await db.select().from(kbSources).where(inArray(kbSources.kbId, kbIds));
  const counts = await db.select({ kbId: kbDocuments.kbId, docs: sql<number>`count(*)::int`, chunks: sql<number>`coalesce(sum(${kbDocuments.chunks}),0)::int` }).from(kbDocuments).where(inArray(kbDocuments.kbId, kbIds)).groupBy(kbDocuments.kbId);
  const byKb = new Map(counts.map((c) => [c.kbId, c]));
  return kbs.map((k) => serializeKb(k, sources.filter((s) => s.kbId === k.id), byKb.get(k.id) ?? { docs: 0, chunks: 0 }));
}

export const knowledgeRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ["knowledge"];
  const idParam = z.object({ id: z.string() });

  app.get("/knowledge-bases", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => ({ data: await kbWithCounts(auth(req).workspaceId) }));

  app.post("/knowledge-bases", { preHandler: app.authorize("knowledge:write"), schema: { tags, body: z.object({ id: z.string().regex(CLIENT_ID_RE).optional(), name: z.string().trim().min(1).max(100), description: z.string().max(1000).default("") }) } }, async (req, reply) => {
    const a = auth(req);
    const [kb] = await db.insert(knowledgeBases).values({ ...req.body, id: req.body.id ?? newId("kb"), workspaceId: a.workspaceId }).returning();
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "kb.created", target: kb.name, ip: req.ip });
    return reply.status(201).send((await kbWithCounts(a.workspaceId, [kb.id]))[0]);
  });

  app.get("/knowledge-bases/:id", { preHandler: app.authorize("workspace:read"), schema: { tags, params: idParam } }, async (req) => assertFound((await kbWithCounts(auth(req).workspaceId, [req.params.id]))[0], "Knowledge base"));

  app.patch("/knowledge-bases/:id", { preHandler: app.authorize("knowledge:write"), schema: { tags, params: idParam, body: z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().max(1000).optional(), usedBy: z.array(z.string()).max(50).optional() }) } }, async (req) => {
    const a = auth(req);
    const [kb] = await db.update(knowledgeBases).set({ ...req.body, updatedAt: new Date() }).where(and(eq(knowledgeBases.id, req.params.id), eq(knowledgeBases.workspaceId, a.workspaceId))).returning();
    assertFound(kb, "Knowledge base");
    return (await kbWithCounts(a.workspaceId, [kb.id]))[0];
  });

  app.delete("/knowledge-bases/:id", { preHandler: app.authorize("knowledge:write"), schema: { tags, params: idParam } }, async (req, reply) => {
    const a = auth(req);
    const [kb] = await db.delete(knowledgeBases).where(and(eq(knowledgeBases.id, req.params.id), eq(knowledgeBases.workspaceId, a.workspaceId))).returning();
    assertFound(kb, "Knowledge base");
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "kb.deleted", target: kb.name, ip: req.ip });
    return reply.status(204).send();
  });

  /** Register a connected source (Drive folder, website, Notion space…). Sync is performed by connector drivers. */
  app.post("/knowledge-bases/:id/sources", { preHandler: app.authorize("knowledge:write"), schema: { tags, params: idParam, body: z.object({ appId: z.string(), label: z.string().max(200) }) } }, async (req, reply) => {
    const a = auth(req);
    assertFound((await db.select().from(knowledgeBases).where(and(eq(knowledgeBases.id, req.params.id), eq(knowledgeBases.workspaceId, a.workspaceId))))[0], "Knowledge base");
    await db.insert(kbSources).values({ id: newId("kbs"), kbId: req.params.id, workspaceId: a.workspaceId, appId: req.body.appId, label: req.body.label, status: "synced", lastSyncAt: new Date() });
    return reply.status(201).send((await kbWithCounts(a.workspaceId, [req.params.id]))[0]);
  });

  app.get("/knowledge-bases/:id/documents", { preHandler: app.authorize("workspace:read"), schema: { tags, params: idParam } }, async (req) => {
    const a = auth(req);
    const rows = await db.select().from(kbDocuments).where(and(eq(kbDocuments.kbId, req.params.id), eq(kbDocuments.workspaceId, a.workspaceId))).orderBy(desc(kbDocuments.createdAt));
    return { data: rows.map((d) => ({ id: d.id, title: d.title, mime: d.mime, url: d.url, bytes: d.bytes, chunks: d.chunks, createdAt: d.createdAt.toISOString() })) };
  });

  /** Add documents: JSON `{title, content}` or multipart text files (txt, md, csv, json, html). */
  app.post("/knowledge-bases/:id/documents", { preHandler: app.authorize("knowledge:write"), schema: { tags, params: idParam } }, async (req, reply) => {
    const a = auth(req);
    assertFound((await db.select().from(knowledgeBases).where(and(eq(knowledgeBases.id, req.params.id), eq(knowledgeBases.workspaceId, a.workspaceId))))[0], "Knowledge base");
    const docs: { title: string; content: string; mime: string; url?: string }[] = [];
    if (req.isMultipart()) {
      for await (const part of req.files()) {
        const text = (await part.toBuffer()).toString("utf8");
        if (!/^text\/|json|csv|markdown|html/.test(part.mimetype) && !/\.(txt|md|csv|json|html?)$/i.test(part.filename)) throw badRequest(`Unsupported file ${part.filename}: upload text-based files (PDF parsing is handled by the ingestion worker)`);
        docs.push({ title: part.filename, content: part.mimetype.includes("html") ? text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ") : text, mime: part.mimetype });
      }
    } else {
      const body = z.object({ title: z.string().min(1).max(300), content: z.string().min(1).max(2_000_000), url: z.string().url().optional() }).parse(req.body);
      docs.push({ ...body, mime: "text/plain" });
    }
    const out = [];
    for (const d of docs) out.push(await ingestDocument({ workspaceId: a.workspaceId, kbId: req.params.id, title: d.title, content: d.content, mime: d.mime, url: d.url }));
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "kb.documents_added", target: `${docs.length} document(s)`, ip: req.ip });
    return reply.status(201).send({ data: out });
  });

  app.delete("/knowledge-bases/:id/documents/:docId", { preHandler: app.authorize("knowledge:write"), schema: { tags, params: z.object({ id: z.string(), docId: z.string() }) } }, async (req, reply) => {
    const a = auth(req);
    const [d] = await db.delete(kbDocuments).where(and(eq(kbDocuments.id, req.params.docId), eq(kbDocuments.kbId, req.params.id), eq(kbDocuments.workspaceId, a.workspaceId))).returning();
    assertFound(d, "Document");
    return reply.status(204).send();
  });

  app.post("/knowledge/search", { preHandler: app.authorize("workspace:read"), schema: { tags, body: z.object({ query: z.string().min(1).max(500), kbIds: z.array(z.string()).optional(), limit: z.number().int().min(1).max(20).default(6) }) } }, async (req) => {
    const hits = await searchKnowledge(auth(req).workspaceId, req.body.query, { kbIds: req.body.kbIds, limit: req.body.limit });
    return { data: hits };
  });

  // ─── Memory ───

  app.get("/memories", { preHandler: app.authorize("workspace:read"), schema: { tags: ["memory"], querystring: z.object({ q: z.string().optional(), scope: z.string().optional(), type: z.string().optional() }) } }, async (req) => {
    const a = auth(req);
    const conds = [eq(memories.workspaceId, a.workspaceId)];
    if (req.query.q) conds.push(sql`${memories.content} ilike ${`%${req.query.q}%`}`);
    if (req.query.scope) conds.push(eq(memories.scope, req.query.scope as "workspace"));
    if (req.query.type) conds.push(eq(memories.type, req.query.type as "fact"));
    const rows = await db.select().from(memories).where(and(...conds)).orderBy(desc(memories.createdAt)).limit(500);
    return { data: rows.map(serializeMemory) };
  });

  const memType = z.enum(["fact", "preference", "glossary", "person", "process"]);
  app.post("/memories", { preHandler: app.authorize("memory:write"), schema: { tags: ["memory"], body: z.object({ content: z.string().trim().min(1).max(1000), scope: z.enum(["workspace", "user", "worker"]).default("workspace"), type: memType.default("fact") }) } }, async (req, reply) => {
    const a = auth(req);
    const [m] = await db.insert(memories).values({ id: newId("mem"), workspaceId: a.workspaceId, ...req.body, scopeId: req.body.scope === "user" ? a.userId : null, source: `Added by ${a.userName}` }).returning();
    return reply.status(201).send(serializeMemory(m));
  });

  app.patch("/memories/:id", { preHandler: app.authorize("memory:write"), schema: { tags: ["memory"], params: idParam, body: z.object({ content: z.string().trim().min(1).max(1000).optional(), type: memType.optional(), scope: z.enum(["workspace", "user", "worker"]).optional() }) } }, async (req) => {
    const a = auth(req);
    const [m] = await db.update(memories).set(req.body).where(and(eq(memories.id, req.params.id), eq(memories.workspaceId, a.workspaceId))).returning();
    return serializeMemory(assertFound(m, "Memory"));
  });

  app.delete("/memories/:id", { preHandler: app.authorize("memory:write"), schema: { tags: ["memory"], params: idParam } }, async (req, reply) => {
    const a = auth(req);
    const [m] = await db.delete(memories).where(and(eq(memories.id, req.params.id), eq(memories.workspaceId, a.workspaceId))).returning();
    assertFound(m, "Memory");
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "memory.deleted", target: m.content.slice(0, 80), ip: req.ip });
    return reply.status(204).send();
  });

  // ─── Skills & packs ───

  app.get("/skills", { preHandler: app.authorize("workspace:read"), schema: { tags: ["memory"] } }, async (req) => {
    const rows = await db.select().from(skills).where(eq(skills.workspaceId, auth(req).workspaceId)).orderBy(desc(skills.createdAt));
    return { data: rows.map(serializeSkill) };
  });

  app.post("/skills", { preHandler: app.authorize("memory:write"), schema: { tags: ["memory"], body: z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(1000), tools: z.array(z.string()).max(30).default([]), stepsMd: z.string().max(20_000).default("") }) } }, async (req, reply) => {
    const a = auth(req);
    const [s] = await db.insert(skills).values({ id: newId("skl"), workspaceId: a.workspaceId, ...req.body, author: "user" }).returning();
    return reply.status(201).send(serializeSkill(s));
  });

  app.delete("/skills/:id", { preHandler: app.authorize("memory:write"), schema: { tags: ["memory"], params: idParam } }, async (req, reply) => {
    const a = auth(req);
    const [s] = await db.delete(skills).where(and(eq(skills.id, req.params.id), eq(skills.workspaceId, a.workspaceId))).returning();
    assertFound(s, "Skill");
    return reply.status(204).send();
  });

  app.get("/skill-packs", { preHandler: app.authorize("workspace:read"), schema: { tags: ["memory"] } }, async (req) => {
    const [ws] = await db.select({ installed: workspaces.installedPacks }).from(workspaces).where(eq(workspaces.id, auth(req).workspaceId));
    return { data: Object.entries(SKILL_PACKS).map(([name, list]) => ({ name, skills: list.length, installed: ws?.installed.includes(name) ?? false })) };
  });

  app.post("/skill-packs/:name/:action", { preHandler: app.authorize("knowledge:write"), schema: { tags: ["memory"], params: z.object({ name: z.string(), action: z.enum(["install", "uninstall"]) }) } }, async (req) => {
    const a = auth(req);
    const pack = SKILL_PACKS[req.params.name];
    if (!pack) throw badRequest("Unknown skill pack");
    await db.transaction(async (tx) => {
      await tx.delete(skills).where(and(eq(skills.workspaceId, a.workspaceId), eq(skills.pack, req.params.name)));
      if (req.params.action === "install") {
        await tx.insert(skills).values(pack.map((s) => ({ id: newId("skl"), workspaceId: a.workspaceId, ...s, author: "pack" as const, pack: req.params.name })));
        await tx.update(workspaces).set({ installedPacks: sql`array_append(array_remove(${workspaces.installedPacks}, ${req.params.name}), ${req.params.name})` }).where(eq(workspaces.id, a.workspaceId));
      } else {
        await tx.update(workspaces).set({ installedPacks: sql`array_remove(${workspaces.installedPacks}, ${req.params.name})` }).where(eq(workspaces.id, a.workspaceId));
      }
    });
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: `skill_pack.${req.params.action}ed`, target: req.params.name, ip: req.ip });
    return { name: req.params.name, installed: req.params.action === "install" };
  });

};
