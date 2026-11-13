import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { webhookDeliveries } from "../src/db/schema.js";
import { charge, checkUsageThresholds, getBalance } from "../src/services/credits.js";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
// These endpoints wait for runs, so jobs must run in the background here.
beforeAll(async () => {
  ctx = await setup();
  await ctx.runner.start();
});
afterAll(async () => {
  await ctx.runner.stop();
  await ctx.app.close();
});

async function apiKey(token: string, scope: string) {
  const r = await client(ctx.app, { token }).post("/v1/api-keys", { name: `k-${scope}`, scope });
  expect(r.status).toBe(201);
  return (r.body.secret ?? r.body.key) as string;
}

describe("OpenAI-compatible chat completions", () => {
  it("answers with model anvita and runs Workers by name", async () => {
    const s = await signup(ctx.app);
    const key = await apiKey(s.token, "all");
    const api = client(ctx.app, { token: key });
    const r = await api.post("/v1/chat/completions", { model: "anvita", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "What can you help me with?" }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ object: "chat.completion", model: "anvita", choices: [{ index: 0, message: { role: "assistant" }, finish_reason: "stop" }] });
    expect(r.body.choices[0].message.content.length).toBeGreaterThan(0);
    expect(r.body.anvita).toMatchObject({ status: "succeeded" });

    const w = await client(ctx.app, s).post("/v1/workers", { from: "blank", name: "Echo bot", interaction: "api", nodes: [{ id: "t1", kind: "trigger", title: "API", x: 0, y: 0 }, { id: "e1", kind: "end", title: "Done", x: 0, y: 100, config: { outcome: "You said: {{ trigger.text }}" } }], edges: [{ id: "t1-e1", source: "t1", target: "e1" }] });
    await client(ctx.app, s).post(`/v1/workers/${w.body.id}/publish`, {});
    const wr = await api.post("/v1/chat/completions", { model: "worker:Echo bot", messages: [{ role: "user", content: "hello" }] });
    expect(wr.body.choices[0].message.content).toBe("You said: hello");
    expect((await api.post("/v1/chat/completions", { model: "gpt-x", messages: [{ role: "user", content: "hi" }] })).body.error.code).toBe("model_not_found");

    const models = (await api.get("/v1/models/openai")).body.data.map((m: any) => m.id);
    expect(models).toEqual(expect.arrayContaining(["anvita", `worker:${w.body.id}`]));

    // stream: true returns OpenAI-style server-sent events.
    const st = await ctx.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: { model: "anvita", stream: true, messages: [{ role: "user", content: "hi" }] } });
    expect(st.headers["content-type"]).toContain("text/event-stream");
    expect(st.body).toContain('"object":"chat.completion.chunk"');
    expect(st.body.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("respects API key scopes", async () => {
    const s = await signup(ctx.app);
    const kbOnly = await apiKey(s.token, "kb:read");
    const r = await client(ctx.app, { token: kbOnly }).post("/v1/chat/completions", { model: "anvita", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(403);
  });
});

describe("MCP server", () => {
  it("speaks JSON-RPC: initialize, tools/list, tools/call with scope checks", async () => {
    const s = await signup(ctx.app);
    const key = await apiKey(s.token, "all");
    const rpc = (token: string, body: unknown) => ctx.app.inject({ method: "POST", url: "/v1/mcp", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" }, payload: body as never });

    const init = (await rpc(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })).json();
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "anvita" }, capabilities: { tools: {} } });
    expect((await rpc(key, { jsonrpc: "2.0", method: "notifications/initialized" })).statusCode).toBe(202);

    const tools = (await rpc(key, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json().result.tools.map((t: any) => t.name);
    expect(tools).toEqual(["ask_anvita", "list_workers", "run_worker", "get_run", "search_knowledge"]);

    const asked = (await rpc(key, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_anvita", arguments: { question: "Summarise what you can do" } } })).json().result;
    expect(asked.isError).toBe(false);
    expect(asked.structuredContent).toMatchObject({ status: "succeeded" });
    const got = (await rpc(key, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_run", arguments: { runId: asked.structuredContent.runId } } })).json().result;
    expect(got.structuredContent.runId).toBe(asked.structuredContent.runId);

    // Batch requests, unknown methods, and tool errors as results.
    const batch = (await rpc(key, [{ jsonrpc: "2.0", id: 5, method: "ping" }, { jsonrpc: "2.0", id: 6, method: "nope" }])).json();
    expect(batch).toEqual([{ jsonrpc: "2.0", id: 5, result: {} }, { jsonrpc: "2.0", id: 6, error: { code: -32601, message: "Method not found: nope" } }]);
    const bad = (await rpc(key, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_worker", arguments: { worker: "Nobody" } } })).json().result;
    expect(bad.isError).toBe(true);

    // A knowledge-only key can search but not run things.
    const kbKey = await apiKey(s.token, "kb:read");
    const denied = (await rpc(kbKey, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "ask_anvita", arguments: { question: "hi" } } })).json().result;
    expect(denied).toMatchObject({ isError: true });
    expect(denied.content[0].text).toMatch(/chat:write/);
    expect((await rpc(kbKey, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "search_knowledge", arguments: { query: "refund policy" } } })).json().result.isError).toBe(false);

    expect((await ctx.app.inject({ method: "POST", url: "/v1/mcp", payload: { jsonrpc: "2.0", id: 1, method: "ping" } })).statusCode).toBe(401);
  });
});

describe("usage thresholds", () => {
  it("emits usage.threshold once when a run pushes usage past 80%", async () => {
    const s = await signup(ctx.app);
    await client(ctx.app, s).post("/v1/webhooks", { url: "http://localhost:9/hook", events: ["usage.threshold"] });
    const b = await getBalance(s.workspaceId);
    const toSeventy = Math.floor(b.creditsTotal * 0.7) - b.creditsUsed;
    await charge(s.workspaceId, toSeventy, { type: "test", id: "a" });
    await checkUsageThresholds(s.workspaceId, toSeventy); // crosses 50%
    const tenMore = Math.ceil(b.creditsTotal * 0.11);
    await charge(s.workspaceId, tenMore, { type: "test", id: "b" });
    await checkUsageThresholds(s.workspaceId, tenMore); // crosses 80%
    await checkUsageThresholds(s.workspaceId, 1); // nothing new
    const rows = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.workspaceId, s.workspaceId), eq(webhookDeliveries.event, "usage.threshold")));
    expect(rows.map((r) => (r.payload as { data?: { threshold: number }; threshold?: number }).data?.threshold ?? (r.payload as { threshold?: number }).threshold).sort()).toEqual([50, 80]);
    const notes = (await client(ctx.app, s).get("/v1/notifications")).body.data;
    expect(notes.some((n: any) => /80% of its credits/.test(n.title))).toBe(true);
  });
});
