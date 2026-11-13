import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { messages, runs, threads, workers } from "../db/schema.js";
import { AppError, badRequest, forbidden, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { allowed, auth, type AuthContext } from "../plugins/auth.js";
import { publish } from "../services/events.js";
import { searchKnowledge } from "../services/knowledge.js";
import { serializeThread } from "../services/serializers.js";
import { startWorkerRun } from "../services/workers.js";
import { startAgentRun } from "./chat.js";

/**
 * Integration surfaces for other tools:
 *
 *   POST /v1/chat/completions   OpenAI-compatible. model "anvita" asks Anvita; "worker:<id or name>"
 *                               runs a Worker with the conversation as input.
 *   POST /v1/mcp                Model Context Protocol server (Streamable HTTP, JSON responses):
 *                               ask_anvita, list_workers, run_worker, get_run, search_knowledge.
 *
 * Both wait for the run (up to a timeout) and return its answer; runs that pause for an approval
 * or a connection return what's pending and the run id to poll. They run outside the per-request
 * tenant transaction so the background worker can see — and finish — the run while we wait.
 */

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const PAUSED = new Set(["waiting_approval", "waiting_auth", "waiting"]);

async function waitForRun(runId: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [r] = await db.select().from(runs).where(eq(runs.id, runId));
    if (!r) throw notFound("Run");
    if (TERMINAL.has(r.status) || PAUSED.has(r.status) || Date.now() > until) return r;
    await new Promise((res) => setTimeout(res, 300));
  }
}

type Run = typeof runs.$inferSelect;

async function answerOf(r: Run): Promise<string> {
  const [m] = r.assistantMessageId ? await db.select({ blocks: messages.blocks }).from(messages).where(eq(messages.id, r.assistantMessageId)) : [];
  const text = ((m?.blocks ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text" && b.text).map((b) => b.text!.trim()).join("\n\n");
  const output = (r.state as { output?: unknown }).output;
  if (text) return text;
  if (output !== undefined && output !== null) return typeof output === "string" ? output : JSON.stringify(output, null, 2);
  return "";
}

function statusNote(r: Run) {
  if (r.status === "waiting_approval") return `\n\n[Paused: waiting for a human approval in Anvita. Run ${r.id}]`;
  if (r.status === "waiting_auth") return `\n\n[Paused: an app needs to be connected in Anvita. Run ${r.id}]`;
  if (r.status === "waiting") return `\n\n[Paused: the workflow is waiting (timer or sub-Worker). Run ${r.id}]`;
  if (r.status === "failed") return `\n\n[Run failed: ${r.error ?? "unknown error"}]`;
  if (!TERMINAL.has(r.status)) return `\n\n[Still running. Poll run ${r.id}]`;
  return "";
}

async function findWorker(a: AuthContext, ref: string) {
  const [w] = await db
    .select()
    .from(workers)
    .where(and(eq(workers.workspaceId, a.workspaceId), or(eq(workers.id, ref), eq(workers.name, ref))))
    .orderBy(desc(workers.updatedAt))
    .limit(1);
  if (!w) throw notFound(`Worker "${ref}"`);
  if (a.apiKeyId && a.scopes && !a.scopes.some((s) => s === "all" || s === "workers:run" || s === `workers:${w.id}:run` || s.startsWith("workers:run") || s === "workers")) throw forbidden("API key scope doesn't allow running this Worker");
  return w;
}

/** Ask Anvita in a new thread and wait. */
async function ask(a: AuthContext, text: string, title: string, timeoutMs: number) {
  if (!allowed(a, "chat:write")) throw forbidden("Requires permission chat:write");
  const [t] = await db.insert(threads).values({ id: newId("thr"), workspaceId: a.workspaceId, createdBy: a.userId, title: title.length > 60 ? `${title.slice(0, 58)}…` : title, channelLabel: a.apiKeyId ? "API" : null }).returning();
  await publish({ workspaceId: a.workspaceId, threadId: t.id, type: "thread.created", data: serializeThread(t) });
  const started = (await startAgentRun(a, t.id, { text })) as { run: { id: string } };
  return waitForRun(started.run.id, timeoutMs);
}

async function runWorker(a: AuthContext, ref: string, inputs: Record<string, unknown>, timeoutMs: number) {
  if (!allowed(a, "workers:run")) throw forbidden("Requires permission workers:run");
  const w = await findWorker(a, ref);
  if ((w.status as string) === "paused") throw badRequest(`${w.name} is paused`);
  const run = await startWorkerRun(w, { trigger: a.apiKeyId ? "API" : "Manual", inputs, createdBy: a.userId, createdByName: a.userName });
  return timeoutMs > 0 ? waitForRun(run.id, timeoutMs) : run;
}

// ─── OpenAI-compatible chat completions ────────────────────────────────────────

const contentPart = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())]);
const chatBody = z.object({
  model: z.string().default("anvita"),
  messages: z.array(z.object({ role: z.enum(["system", "developer", "user", "assistant", "tool"]), content: contentPart.nullable().optional() }).passthrough()).min(1),
  stream: z.boolean().optional(),
  user: z.string().max(200).optional(),
});

const plain = (c: z.infer<typeof contentPart> | null | undefined) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join("\n")).trim();

export const publicApiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post("/chat/completions", { preHandler: app.authorize("workspace:read"), config: { tenant: false }, schema: { tags: ["openai-compatible"], body: chatBody } }, async (req, reply) => {
    const a = auth(req);
    const msgs = req.body.messages.map((m) => ({ role: m.role, text: plain(m.content) })).filter((m) => m.text);
    const last = [...msgs].reverse().find((m) => m.role === "user");
    if (!last) throw badRequest("messages must include a user message");
    const earlier = msgs.slice(0, msgs.lastIndexOf(last));
    const text = earlier.length ? `${earlier.map((m) => `${m.role === "assistant" ? "Assistant" : m.role === "user" ? "User" : "Instructions"}: ${m.text}`).join("\n\n")}\n\nUser: ${last.text}` : last.text;

    const model = req.body.model;
    let r: Run;
    if (model === "anvita" || model === "default") r = await ask(a, text, last.text, 120_000);
    else if (model.startsWith("worker:")) r = (await runWorker(a, model.slice("worker:".length), { text, messages: msgs }, 120_000)) as Run;
    else throw new AppError(404, "model_not_found", `Unknown model "${model}". Use "anvita" or "worker:<Worker id or name>".`);

    const content = `${await answerOf(r)}${statusNote(r)}`.trim();
    const id = `chatcmpl-${r.id}`;
    const created = Math.floor(Date.now() / 1000);
    const finish = r.status === "succeeded" ? "stop" : "length";
    const anvita = { runId: r.id, threadId: r.threadId, status: r.status, credits: r.creditsUsed };
    if (req.body.stream) {
      // One content chunk (the run has already finished or paused), then the terminator.
      reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      reply.raw.write(chunk({ role: "assistant", content }, null));
      reply.raw.write(chunk({}, finish));
      reply.raw.end("data: [DONE]\n\n");
      return reply;
    }
    return { id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, anvita };
  });

  app.get("/models/openai", { preHandler: app.authorize("workspace:read"), schema: { tags: ["openai-compatible"] } }, async (req) => {
    const a = auth(req);
    const ws = await db.select({ id: workers.id, name: workers.name }).from(workers).where(and(eq(workers.workspaceId, a.workspaceId), inArray(workers.status, ["live", "canary"])));
    return { object: "list", data: [{ id: "anvita", object: "model", owned_by: "anvita" }, ...ws.map((w) => ({ id: `worker:${w.id}`, object: "model", owned_by: "anvita", name: w.name }))] };
  });

  // ─── MCP server ───

  const TOOLS = [
    { name: "ask_anvita", description: "Ask Anvita (the company's AI assistant with access to connected apps and knowledge). Returns the answer.", inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
    { name: "list_workers", description: "List the AI Workers in this workspace that can be run.", inputSchema: { type: "object", properties: {} } },
    { name: "run_worker", description: "Run an AI Worker by id or name with optional inputs, and wait for its result (up to 60 s).", inputSchema: { type: "object", properties: { worker: { type: "string", description: "Worker id or exact name" }, inputs: { type: "object" }, wait: { type: "boolean", default: true } }, required: ["worker"] } },
    { name: "get_run", description: "Get a run's status and result.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] } },
    { name: "search_knowledge", description: "Search the company's knowledge bases. Returns matching passages with titles.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] } },
  ];

  const runSummary = async (r: Run) => ({ runId: r.id, status: r.status, result: await answerOf(r), error: r.error ?? undefined, note: statusNote(r).trim() || undefined });

  async function callTool(a: AuthContext, name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "ask_anvita": {
        const q = String(args.question ?? "").trim();
        if (!q) throw badRequest("question is required");
        return runSummary(await ask(a, q, q, 60_000));
      }
      case "list_workers": {
        const rows = await db.select({ id: workers.id, name: workers.name, description: workers.description, status: workers.status }).from(workers).where(and(eq(workers.workspaceId, a.workspaceId), inArray(workers.status, ["live", "canary", "draft"])));
        return rows;
      }
      case "run_worker": {
        const r = (await runWorker(a, String(args.worker ?? ""), (args.inputs as Record<string, unknown>) ?? {}, args.wait === false ? 0 : 60_000)) as Run;
        return runSummary(r);
      }
      case "get_run": {
        const [r] = await db.select().from(runs).where(and(eq(runs.id, String(args.runId ?? "")), eq(runs.workspaceId, a.workspaceId)));
        if (!r) throw notFound("Run");
        return runSummary(r);
      }
      case "search_knowledge": {
        const hits = await searchKnowledge(a.workspaceId, String(args.query ?? ""), { limit: Math.min(20, Number(args.limit) || 5) });
        return hits.map((h) => ({ title: h.title, text: h.content, score: h.score }));
      }
      default:
        throw new AppError(404, "unknown_tool", `Unknown tool ${name}`);
    }
  }

  type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
  const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } });

  async function handle(a: AuthContext, m: Rpc) {
    if (m.id === undefined) return null; // notification (e.g. notifications/initialized)
    switch (m.method) {
      case "initialize":
        return { jsonrpc: "2.0", id: m.id, result: { protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "anvita", version: "1.0.0" }, instructions: "Tools for the Anvita AI Workers platform: ask the company assistant, run AI Workers, check runs and search company knowledge." } };
      case "ping":
        return { jsonrpc: "2.0", id: m.id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } };
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        try {
          const out = await callTool(a, name, (m.params?.arguments as Record<string, unknown>) ?? {});
          return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }], structuredContent: Array.isArray(out) ? { items: out } : out, isError: false } };
        } catch (e) {
          // Tool failures are results the model can read, not protocol errors.
          return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: (e as Error).message }], isError: true } };
        }
      }
      default:
        return rpcError(m.id, -32601, `Method not found: ${m.method}`);
    }
  }

  app.post("/mcp", { preHandler: app.authorize("workspace:read"), config: { tenant: false }, schema: { tags: ["mcp"] } }, async (req, reply) => {
    const a = auth(req);
    const body = req.body as Rpc | Rpc[];
    const batch = Array.isArray(body) ? body : [body];
    if (!batch.length || batch.some((m) => !m || m.jsonrpc !== "2.0" || typeof m.method !== "string")) return reply.status(400).send(rpcError(null, -32600, "Invalid JSON-RPC request"));
    const out = (await Promise.all(batch.map((m) => handle(a, m)))).filter(Boolean);
    if (!out.length) return reply.status(202).send();
    return Array.isArray(body) ? out : out[0];
  });
  // Streamable HTTP: we don't offer a server-initiated stream.
  app.get("/mcp", { schema: { hide: true } }, async (_req, reply) => reply.status(405).header("allow", "POST").send());
  app.delete("/mcp", { schema: { hide: true } }, async (_req, reply) => reply.status(405).header("allow", "POST").send());
};
