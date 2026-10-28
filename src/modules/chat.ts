import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { config } from "../config.js";
import type { ChatBlock } from "../contracts/web.js";
import { db } from "../db/client.js";
import { isTextMime } from "../services/artifacts.js";
import { initialWorkflowState, workflowTrace } from "../workflow/engine.js";
import { artifacts, messages, runs, runSteps, threads, workers } from "../db/schema.js";
import { assertFound, badRequest } from "../lib/errors.js";
import { CLIENT_ID_RE, newId } from "../lib/ids.js";
import { enqueue } from "../jobs/queue.js";
import { auth, type AuthContext } from "../plugins/auth.js";
import { assertCredits } from "../services/credits.js";
import { fetchEventsAfter, latestEventId, onWorkspaceEvent, publish } from "../services/events.js";
import { serializeMessage, serializeRun, serializeThread } from "../services/serializers.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "../runtime/model.js";

const TEXT_MIME = /^(text\/|application\/(json|csv|xml|x-yaml|markdown))/;
const DOC_MIME = new Set(["application/pdf"]);
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function kindForMime(mime: string, name: string): "pdf" | "sheet" | "doc" | "chart" {
  if (mime === "application/pdf") return "pdf";
  if (/csv|spreadsheet|excel/.test(mime) || /\.(csv|xlsx?)$/i.test(name)) return "sheet";
  if (mime.startsWith("image/")) return "chart";
  return "doc";
}

/** Build the model transcript: recent thread history as plain text, then the new user turn with attachments. */
async function buildTranscript(threadId: string, text: string, attachmentIds: string[], workspaceId: string): Promise<MessageParam[]> {
  const history = await db.select().from(messages).where(and(eq(messages.threadId, threadId), eq(messages.streaming, false))).orderBy(desc(messages.createdAt)).limit(20);
  const transcript: MessageParam[] = [];
  for (const m of history.reverse()) {
    const t = (m.blocks as ChatBlock[]).filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n\n").trim();
    if (!t) continue;
    const last = transcript[transcript.length - 1];
    if (last && last.role === m.role) last.content = `${last.content as string}\n\n${t}`;
    else transcript.push({ role: m.role, content: t });
  }
  while (transcript.length && transcript[0].role !== "user") transcript.shift();

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (attachmentIds.length) {
    const files = await db.select().from(artifacts).where(and(eq(artifacts.workspaceId, workspaceId), inArray(artifacts.id, attachmentIds)));
    for (const f of files) {
      if (DOC_MIME.has(f.mime)) content.push({ type: "document", title: f.title, source: { type: "base64", media_type: "application/pdf", data: f.content } });
      else if (IMAGE_MIME.has(f.mime)) content.push({ type: "image", source: { type: "base64", media_type: f.mime as "image/png", data: f.content } });
      else content.push({ type: "document", title: f.title, source: { type: "text", media_type: "text/plain", data: f.content.slice(0, 400_000) } });
    }
  }
  content.push({ type: "text", text });
  const last = transcript[transcript.length - 1];
  if (last?.role === "user") transcript.pop(); // a dangling user turn (e.g. a failed run) would break role alternation
  transcript.push({ role: "user", content });
  return transcript;
}

export interface RunOptions {
  /** Run as this Worker (instructions, apps). Used for channel-bound Workers like WhatsApp support. */
  workerId?: string | null;
  trigger?: string;
  /** End-customer conversation: adds the human-handoff tool and keeps internal tools away. */
  customer?: boolean;
}

export async function startAgentRun(a: AuthContext, threadId: string, body: { text: string; attachments?: string[]; web?: boolean }, opts: RunOptions = {}) {
  await assertCredits(a.workspaceId, 50);
  const thread = assertFound((await db.select().from(threads).where(and(eq(threads.id, threadId), eq(threads.workspaceId, a.workspaceId))))[0], "Thread");
  const attachments = body.attachments ?? [];
  const files = attachments.length ? await db.select().from(artifacts).where(and(eq(artifacts.workspaceId, a.workspaceId), inArray(artifacts.id, attachments))) : [];
  if (files.length !== attachments.length) throw badRequest("One or more attachments were not found");
  const transcript = await buildTranscript(thread.id, body.text, attachments, a.workspaceId);

  // A Worker with a workflow graph executes it step by step; otherwise the agent answers.
  const [graphWorker] = opts.workerId ? await db.select().from(workers).where(and(eq(workers.id, opts.workerId), eq(workers.engine, "graph"))) : [];
  const initialState = graphWorker?.nodes.length ? (initialWorkflowState({ nodes: graphWorker.nodes, edges: graphWorker.edges }) as unknown as Record<string, unknown>) : { transcript, turns: 0, sources: [], toolSteps: 0 };

  const runId = newId("run");
  const now = Date.now();
  const userMsg = { id: newId("msg"), workspaceId: a.workspaceId, threadId: thread.id, role: "user" as const, author: a.userName, authorId: a.userId, runId, createdAt: new Date(now), blocks: [{ type: "text", text: body.text }, ...files.map((f) => ({ type: "artifact", artifact: { id: f.id, kind: f.kind, title: f.title, subtitle: f.subtitle ?? undefined, size: `${Math.max(1, Math.round(f.sizeBytes / 1024))} KB` } }))] };
  const asstMsg = { id: newId("msg"), workspaceId: a.workspaceId, threadId: thread.id, role: "assistant" as const, author: opts.workerId ? ((await db.select({ name: workers.name }).from(workers).where(eq(workers.id, opts.workerId)))[0]?.name ?? "Anvita") : "Anvita", runId, streaming: true, createdAt: new Date(now + 1), blocks: [] };

  const result = await db.transaction(async (tx) => {
    const [um] = await tx.insert(messages).values(userMsg).returning();
    const [am] = await tx.insert(messages).values(asstMsg).returning();
    const [run] = await tx
      .insert(runs)
      .values({ id: runId, workspaceId: a.workspaceId, kind: "agent", threadId: thread.id, workerId: opts.workerId ?? null, trigger: opts.trigger ?? "chat", assistantMessageId: am.id, createdBy: a.userId, createdByName: a.userName, input: { text: body.text, web: !!body.web, attachments, ...(opts.customer ? { customer: true } : {}) }, state: initialState, ...(graphWorker ? { workerVersion: graphWorker.version } : {}) })
      .returning();
    const [t] = await tx.update(threads).set({ status: "running", updatedAt: new Date() }).where(eq(threads.id, thread.id)).returning();
    await publish({ workspaceId: a.workspaceId, threadId: thread.id, runId, type: "message.created", data: serializeMessage(um) }, tx);
    await publish({ workspaceId: a.workspaceId, threadId: thread.id, runId, type: "message.created", data: serializeMessage(am) }, tx);
    await publish({ workspaceId: a.workspaceId, threadId: thread.id, type: "thread.updated", data: serializeThread(t) }, tx);
    await enqueue("run.advance", { runId }, { maxAttempts: 3 }, tx);
    return { run: serializeRun(run), userMessage: serializeMessage(um), assistantMessage: serializeMessage(am) };
  });
  return result;
}

export const chatRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ["chat"];
  const idParam = z.object({ id: z.string() });

  app.get("/threads", { preHandler: app.authorize("workspace:read"), schema: { tags, querystring: z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50), before: z.string().datetime().optional() }) } }, async (req) => {
    const a = auth(req);
    const conds = [eq(threads.workspaceId, a.workspaceId)];
    if (req.query.q) conds.push(sql`${threads.title} ilike ${`%${req.query.q}%`}`);
    if (req.query.before) conds.push(lt(threads.updatedAt, new Date(req.query.before)));
    const rows = await db.select().from(threads).where(and(...conds)).orderBy(desc(threads.pinned), desc(threads.updatedAt)).limit(req.query.limit);
    return { data: rows.map((t) => serializeThread(t)), nextBefore: rows.length === req.query.limit ? rows[rows.length - 1].updatedAt.toISOString() : null };
  });

  app.post("/threads", { preHandler: app.authorize("chat:write"), schema: { tags, body: z.object({ id: z.string().regex(CLIENT_ID_RE).optional(), title: z.string().trim().max(200).optional(), text: z.string().trim().min(1).max(50_000).optional(), attachments: z.array(z.string()).max(10).optional(), web: z.boolean().optional() }) } }, async (req, reply) => {
    const a = auth(req);
    const title = req.body.title || (req.body.text ? (req.body.text.length > 60 ? `${req.body.text.slice(0, 58).trim()}…` : req.body.text) : "New chat");
    const [t] = await db.insert(threads).values({ id: req.body.id ?? newId("thr"), workspaceId: a.workspaceId, createdBy: a.userId, title }).returning();
    await publish({ workspaceId: a.workspaceId, threadId: t.id, type: "thread.created", data: serializeThread(t) });
    if (!req.body.text) return reply.status(201).send(serializeThread(t, []));
    const started = await startAgentRun(a, t.id, { text: req.body.text, attachments: req.body.attachments, web: req.body.web });
    return reply.status(201).send({ ...serializeThread(t, []), ...started });
  });

  app.get("/threads/:id", { preHandler: app.authorize("workspace:read"), schema: { tags, params: idParam } }, async (req) => {
    const a = auth(req);
    const t = assertFound((await db.select().from(threads).where(and(eq(threads.id, req.params.id), eq(threads.workspaceId, a.workspaceId))))[0], "Thread");
    const msgs = await db.select().from(messages).where(eq(messages.threadId, t.id)).orderBy(asc(messages.createdAt));
    if (t.unread) await db.update(threads).set({ unread: false }).where(eq(threads.id, t.id));
    return serializeThread(t, msgs);
  });

  app.patch("/threads/:id", { preHandler: app.authorize("chat:write"), schema: { tags, params: idParam, body: z.object({ title: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional(), unread: z.boolean().optional() }) } }, async (req) => {
    const a = auth(req);
    const [t] = await db.update(threads).set(req.body).where(and(eq(threads.id, req.params.id), eq(threads.workspaceId, a.workspaceId))).returning();
    assertFound(t, "Thread");
    await publish({ workspaceId: a.workspaceId, threadId: t.id, type: "thread.updated", data: serializeThread(t) });
    return serializeThread(t);
  });

  app.delete("/threads/:id", { preHandler: app.authorize("chat:write"), schema: { tags, params: idParam } }, async (req, reply) => {
    const a = auth(req);
    await db.update(runs).set({ status: "cancelled", endedAt: new Date() }).where(and(eq(runs.threadId, req.params.id), eq(runs.workspaceId, a.workspaceId), inArray(runs.status, ["queued", "running", "waiting_approval", "waiting_auth"])));
    const [t] = await db.delete(threads).where(and(eq(threads.id, req.params.id), eq(threads.workspaceId, a.workspaceId))).returning({ id: threads.id });
    assertFound(t, "Thread");
    await publish({ workspaceId: a.workspaceId, threadId: t.id, type: "thread.deleted", data: { id: t.id } });
    return reply.status(204).send();
  });

  app.post("/threads/:id/messages", { preHandler: app.authorize("chat:write"), schema: { tags, params: idParam, body: z.object({ text: z.string().trim().min(1).max(50_000), attachments: z.array(z.string()).max(10).optional(), web: z.boolean().optional() }) } }, async (req, reply) => {
    return reply.status(202).send(await startAgentRun(auth(req), req.params.id, req.body));
  });

  /** Mark an offered "Save as AI Worker" card as saved/dismissed. */
  app.patch("/messages/:id/harden", { preHandler: app.authorize("chat:write"), schema: { tags, params: idParam, body: z.object({ status: z.enum(["saved", "dismissed"]) }) } }, async (req) => {
    const a = auth(req);
    const m = assertFound((await db.select().from(messages).where(and(eq(messages.id, req.params.id), eq(messages.workspaceId, a.workspaceId))))[0], "Message");
    const blocks = (m.blocks as ChatBlock[]).map((b) => (b.type === "harden" ? { ...b, status: req.body.status } : b));
    const [u] = await db.update(messages).set({ blocks }).where(eq(messages.id, m.id)).returning();
    await publish({ workspaceId: a.workspaceId, threadId: m.threadId, type: "message.updated", data: serializeMessage(u) });
    return serializeMessage(u);
  });

  // ─── Runs ───

  app.get("/runs", { preHandler: app.authorize("workspace:read"), schema: { tags: ["runs"], querystring: z.object({ workerId: z.string().optional(), threadId: z.string().optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime().optional() }) } }, async (req) => {
    const a = auth(req);
    const q = req.query;
    const conds = [eq(runs.workspaceId, a.workspaceId)];
    if (q.workerId) conds.push(eq(runs.workerId, q.workerId));
    if (q.threadId) conds.push(eq(runs.threadId, q.threadId));
    if (q.status) conds.push(inArray(runs.status, q.status.split(",") as (typeof runs.$inferSelect.status)[]));
    if (q.before) conds.push(lt(runs.createdAt, new Date(q.before)));
    const rows = await db.select().from(runs).where(and(...conds)).orderBy(desc(runs.createdAt)).limit(q.limit);
    return { data: rows.map(serializeRun), nextBefore: rows.length === q.limit ? rows[rows.length - 1].createdAt.toISOString() : null };
  });

  app.get("/runs/:id", { preHandler: app.authorize("workspace:read"), schema: { tags: ["runs"], params: idParam } }, async (req) => {
    const a = auth(req);
    const r = assertFound((await db.select().from(runs).where(and(eq(runs.id, req.params.id), eq(runs.workspaceId, a.workspaceId))))[0], "Run");
    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, r.id)).orderBy(asc(runSteps.startedAt));
    const trace = workflowTrace(r);
    return { ...serializeRun(r), blocks: (r.state as { blocks?: unknown[] }).blocks ?? null, output: (r.state as { output?: unknown }).output ?? null, trace, stepLog: steps.map((s) => ({ id: s.id, kind: s.kind, name: s.name, label: s.label, appId: s.appId, status: s.status, model: s.model, tokens: s.tokens, credits: s.credits, startedAt: s.startedAt?.toISOString(), endedAt: s.endedAt?.toISOString() })) };
  });

  app.get("/runs/:id/trace", { preHandler: app.authorize("workspace:read"), schema: { tags: ["runs"], params: idParam } }, async (req) => {
    const a = auth(req);
    const r = assertFound((await db.select().from(runs).where(and(eq(runs.id, req.params.id), eq(runs.workspaceId, a.workspaceId))))[0], "Run");
    const trace = workflowTrace(r);
    if (!trace) throw badRequest("This run didn't execute a workflow graph");
    return { runId: r.id, status: r.status, error: r.error, ...trace };
  });

  app.post("/runs/:id/cancel", { preHandler: app.authorize("chat:write"), schema: { tags: ["runs"], params: idParam } }, async (req) => {
    const a = auth(req);
    const [r] = await db.update(runs).set({ status: "cancelled", endedAt: new Date() }).where(and(eq(runs.id, req.params.id), eq(runs.workspaceId, a.workspaceId), inArray(runs.status, ["queued", "running", "waiting_approval", "waiting_auth"]))).returning();
    if (!r) throw badRequest("Run is not active");
    // Workers called by this run stop too.
    await db.update(runs).set({ status: "cancelled", endedAt: new Date() }).where(and(eq(runs.parentRunId, r.id), inArray(runs.status, ["queued", "running", "waiting_approval", "waiting_auth"])));
    if (r.threadId) {
      const [t] = await db.update(threads).set({ status: "done" }).where(eq(threads.id, r.threadId)).returning();
      if (r.assistantMessageId) {
        const [m] = await db.update(messages).set({ streaming: false }).where(eq(messages.id, r.assistantMessageId)).returning();
        if (m) await publish({ workspaceId: a.workspaceId, threadId: r.threadId, type: "message.updated", data: serializeMessage(m) });
      }
      if (t) await publish({ workspaceId: a.workspaceId, threadId: t.id, type: "thread.updated", data: serializeThread(t) });
    }
    await publish({ workspaceId: a.workspaceId, runId: r.id, threadId: r.threadId, type: "run.updated", data: serializeRun(r) });
    return serializeRun(r);
  });

  // ─── Files / artifacts ───

  app.post("/files", { preHandler: app.authorize("chat:write"), schema: { tags: ["files"], consumes: ["multipart/form-data"] } }, async (req, reply) => {
    const a = auth(req);
    const out = [];
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      const mime = part.mimetype || "application/octet-stream";
      const isText = TEXT_MIME.test(mime) || /\.(txt|md|csv|json|tsv)$/i.test(part.filename);
      if (!isText && !DOC_MIME.has(mime) && !IMAGE_MIME.has(mime)) throw badRequest(`Unsupported file type ${mime}. Upload text, CSV, JSON, Markdown, PDF or images.`);
      const [row] = await db
        .insert(artifacts)
        .values({ id: newId("art"), workspaceId: a.workspaceId, kind: kindForMime(mime, part.filename), title: part.filename, subtitle: "Uploaded", mime: isText ? (TEXT_MIME.test(mime) ? mime : "text/plain") : mime, sizeBytes: buf.length, content: isText ? buf.toString("utf8") : buf.toString("base64") })
        .returning();
      out.push({ id: row.id, kind: row.kind, title: row.title, subtitle: row.subtitle, size: `${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`, createdAt: row.createdAt.toISOString() });
    }
    return reply.status(201).send({ data: out });
  });

  app.get("/artifacts/:id", { preHandler: app.authorize("workspace:read"), schema: { tags: ["files"], params: idParam } }, async (req) => {
    const a = auth(req);
    const f = assertFound((await db.select({ id: artifacts.id, kind: artifacts.kind, title: artifacts.title, subtitle: artifacts.subtitle, mime: artifacts.mime, sizeBytes: artifacts.sizeBytes, runId: artifacts.runId, threadId: artifacts.threadId, createdAt: artifacts.createdAt }).from(artifacts).where(and(eq(artifacts.id, req.params.id), eq(artifacts.workspaceId, a.workspaceId))))[0], "Artifact");
    return { ...f, size: `${Math.max(1, Math.round(f.sizeBytes / 1024))} KB`, createdAt: f.createdAt.toISOString(), downloadUrl: `/v1/artifacts/${f.id}/content` };
  });

  app.get("/artifacts/:id/content", { preHandler: app.authorize("workspace:read"), schema: { tags: ["files"], params: idParam } }, async (req, reply) => {
    const a = auth(req);
    const f = assertFound((await db.select().from(artifacts).where(and(eq(artifacts.id, req.params.id), eq(artifacts.workspaceId, a.workspaceId))))[0], "Artifact");
    const binary = !isTextMime(f.mime);
    reply.header("content-type", binary ? f.mime : `${f.mime}; charset=utf-8`);
    reply.header("content-disposition", `attachment; filename="${encodeURIComponent(f.title)}"`);
    // HTML artifacts are user/model generated: never let them run on the API origin.
    reply.header("content-security-policy", "sandbox");
    return reply.send(binary ? Buffer.from(f.content, "base64") : f.content);
  });

  // ─── Realtime ───

  /**
   * Server-Sent Events. Streams workspace events (optionally filtered to a thread or run) and
   * resumes from `Last-Event-ID` / `?after=` after reconnects. EventSource clients may pass
   * `?access_token=` since they can't set headers.
   */
  app.get("/events/stream", { preHandler: app.authorize("workspace:read"), config: { tenant: false }, schema: { tags: ["realtime"], querystring: z.object({ threadId: z.string().optional(), runId: z.string().optional(), after: z.coerce.number().int().optional(), access_token: z.string().optional() }) } }, async (req, reply) => {
    const a = auth(req);
    const lastHeader = Number(req.headers["last-event-id"]);
    let last = Number.isFinite(lastHeader) && lastHeader > 0 ? lastHeader : (req.query.after ?? (await latestEventId(a.workspaceId)));
    const filter = { workspaceId: a.workspaceId, userId: a.userId ?? "", threadId: req.query.threadId, runId: req.query.runId };

    const headers = { ...reply.getHeaders(), "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } as Record<string, string>;
    reply.hijack();
    reply.raw.writeHead(200, headers);
    reply.raw.write(`retry: 3000\n: connected\n\n`);

    let busy = false;
    let again = false;
    let closed = false;
    const pump = async () => {
      if (busy) return void (again = true);
      busy = true;
      try {
        do {
          again = false;
          const rows = await fetchEventsAfter(filter, last);
          for (const r of rows) {
            if (closed) return;
            reply.raw.write(`id: ${r.id}\nevent: ${r.type}\ndata: ${JSON.stringify(r.data)}\n\n`);
            last = r.id;
          }
          if (rows.length === 200) again = true;
        } while (again && !closed);
      } catch (err) {
        req.log.warn({ err }, "sse pump failed");
      } finally {
        busy = false;
      }
    };
    const unsubscribe = onWorkspaceEvent(a.workspaceId, () => void pump());
    const heartbeat = setInterval(() => reply.raw.write(`: ping\n\n`), 15_000);
    const close = () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on("close", close);
    await pump();
  });

  app.get("/models", { preHandler: app.authorize("workspace:read"), schema: { tags: ["runs"] } }, async () => ({ act: config.MODEL_ACT, plan: config.MODEL_PLAN, fast: config.MODEL_FAST }));
};
