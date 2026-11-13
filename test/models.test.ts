import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { routeTier, type ModelSettings } from "../src/services/model-settings.js";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
let mock: MockAgent;
let original: Dispatcher;

beforeAll(async () => {
  ctx = await setup();
  original = getGlobalDispatcher();
});
afterAll(async () => {
  setGlobalDispatcher(original);
  await ctx.app.close();
});
beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});

const sse = (text: string, model: string) =>
  [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }],
    ["message_stop", { type: "message_stop" }],
  ]
    .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    .join("");

describe("model settings", () => {
  it("routes tiers by the workspace's choices", () => {
    const base: ModelSettings = { routing: "balanced", fast: true, precise: true, webBrowsing: true, fallback: true, apiKey: null };
    expect(routeTier("act", base)).toBe("act");
    expect(routeTier("act", { ...base, routing: "quality" })).toBe("plan");
    expect(routeTier("plan", { ...base, routing: "economy" })).toBe("act");
    expect(routeTier("plan", { ...base, precise: false })).toBe("act");
    expect(routeTier("fast", { ...base, fast: false })).toBe("act");
  });

  it("validates and stores a workspace's own Anthropic key, and runs chats on it with the workspace's routing", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const before = (await api.get("/v1/models")).body;
    expect(before).toMatchObject({ provider: "scripted", routing: "balanced", webBrowsing: true, fallback: true, apiKey: null });
    expect(before.tiers.map((t: any) => t.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);

    const anthropic = mock.get("https://api.anthropic.com");
    anthropic.intercept({ path: /^\/v1\/models/, method: "GET" }).reply(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { headers: { "content-type": "application/json" } });
    const bad = await api.put("/v1/models/key", { apiKey: "sk-ant-api03-wrong-key-000000000000" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/rejected this key/);

    anthropic.intercept({ path: /^\/v1\/models/, method: "GET" }).reply(200, { data: [{ id: "claude-opus-5-5", type: "model", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-opus-5-5" }, { headers: { "content-type": "application/json" } });
    const key = "sk-ant-api03-workspace-own-key-1234";
    const ok = await api.put("/v1/models/key", { apiKey: key });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ last4: "1234", models: ["claude-opus-5-5"] });
    expect((await api.get("/v1/models")).body).toMatchObject({ provider: "byo", apiKey: { last4: "1234" } });

    await api.patch("/v1/workspace/settings", { "models.routing": "quality", "models.webBrowsing": false, "models.fallback": false });

    const calls: { headers: Record<string, string>; body: any }[] = [];
    anthropic
      .intercept({ path: /^\/v1\/messages/, method: "POST" })
      .reply((o) => {
        const body = JSON.parse(String(o.body));
        const h = o.headers as unknown;
        const headers: Record<string, string> = h instanceof Headers ? Object.fromEntries(h.entries()) : Array.isArray(h) ? Object.fromEntries(Array.from({ length: h.length / 2 }, (_, i) => [String(h[i * 2]).toLowerCase(), String(h[i * 2 + 1])])) : Object.fromEntries(Object.entries((h ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
        calls.push({ headers, body });
        return { statusCode: 200, data: sse("Here is your answer from your own key.", body.model), responseOptions: { headers: { "content-type": "text/event-stream" } } };
      })
      .persist();
    const t = await api.post("/v1/threads", { text: "Summarise what Anvita can do", web: true });
    await ctx.runner.drain();
    expect(calls.length).toBeGreaterThan(0);
    const c = calls[0];
    expect(c.headers.authorization).toBe(`Bearer ${key}`); // SDK 1.x sends API keys as a bearer token
    expect(c.body.model).toBe("claude-opus-5-5"); // routing "quality"
    expect(c.body.fallbacks).toBeUndefined();
    expect((c.body.tools ?? []).some((x: any) => x.type?.startsWith("web_search"))).toBe(false);

    const run = (await api.get(`/v1/runs/${t.body.run.id}`)).body;
    expect(run.status).toBe("succeeded");
    const th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    expect(JSON.stringify(th)).toContain("Here is your answer from your own key.");
    // Tokens on the workspace's own key aren't charged as credits.
    const llm = (await api.get(`/v1/runs/${t.body.run.id}`)).body.stepLog.filter((x: any) => x.kind === "llm");
    expect(llm.length).toBeGreaterThan(0);
    for (const st of llm) expect(st).toMatchObject({ model: "claude-opus-5-5", credits: 0 });

    expect((await api.del("/v1/models/key")).status).toBe(204);
    expect((await api.get("/v1/models")).body).toMatchObject({ provider: "scripted", apiKey: null });
  });
});
