import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
let server: Server;
let url = "";
const calls: { method: string; session?: string; args?: unknown }[] = [];

/** A small Streamable-HTTP MCP server: bearer auth, session ids, SSE for tools/call. */
function startMcp() {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer mcp-secret") return res.writeHead(401).end();
      const msg = JSON.parse(body);
      calls.push({ method: msg.method, session: req.headers["mcp-session-id"] as string | undefined, args: msg.params?.arguments });
      if (!("id" in msg)) return res.writeHead(202).end();
      const reply = (result: unknown, sse = false) => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
        if (sse) return res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" }).end(`event: message\ndata: ${payload}\n\n`);
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" }).end(payload);
      };
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "weather" } });
      if (msg.method === "tools/list")
        return reply(
          msg.params?.cursor
            ? { tools: [{ name: "delete_record", description: "Delete a record", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { destructiveHint: true } }] }
            : { tools: [{ name: "get_forecast", description: "Weather forecast for a city", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true, title: "Get forecast" } }], nextCursor: "p2" },
        );
      if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: `Sunny in Mumbai, 31°C (${msg.params.name})` }] }, true);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
    });
  });
  return new Promise<void>((r) => server.listen(0, "127.0.0.1", () => ((url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), r())));
}

beforeAll(async () => {
  ctx = await setup();
  await startMcp();
});
afterAll(async () => {
  server.close();
  await ctx.app.close();
});

describe("MCP servers", () => {
  it("discovers tools (with pagination) and reports auth failures", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const bad = await api.post("/v1/mcp-servers", { name: "Weather", url, auth: "bearer", token: "wrong" });
    expect(bad.status).toBe(201);
    expect(bad.body).toMatchObject({ status: "error", tools: 0 });
    expect(bad.body.lastError).toContain("401");

    const ok = await api.post("/v1/mcp-servers", { name: "Weather", url, auth: "bearer", token: "mcp-secret" });
    expect(ok.body).toMatchObject({ status: "healthy", tools: 2, toolNames: ["get_forecast", "delete_record"] });
    // Session id from initialize is echoed on later requests.
    expect(calls.filter((c) => c.method === "tools/list").every((c) => c.session === "sess-1")).toBe(true);
  });

  it("lets the agent call read-only MCP tools and gates destructive ones behind approval", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.post("/v1/mcp-servers", { name: "Weather", url, auth: "bearer", token: "mcp-secret" });

    const t = await api.post("/v1/threads", { text: "Use get_forecast for Mumbai tomorrow" });
    await ctx.runner.drain();
    const th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    const step = th.messages[1].blocks.find((b: any) => b.type === "steps").steps.find((x: any) => x.label.includes("Weather"));
    expect(step).toMatchObject({ status: "done", detail: "Sunny in Mumbai, 31°C (get_forecast)", label: "Get forecast (Weather)" });
    expect(calls.find((c) => c.method === "tools/call")?.args).toEqual({ query: "Use get_forecast for Mumbai tomorrow" });

    await api.post("/v1/threads", { text: "Run delete_record on the stale entry" });
    await ctx.runner.drain();
    const pending = (await api.get("/v1/approvals?status=pending")).body.data;
    expect(pending[0]).toMatchObject({ action: "mcp.weather.delete_record" });
    expect(pending[0].reason).toContain("approval");
  });
});
