/**
 * Minimal MCP client over the Streamable HTTP transport (protocol 2025-06-18): initialize →
 * notifications/initialized → tools/list | tools/call. Handles JSON and SSE responses and the
 * Mcp-Session-Id header. Each operation opens a fresh session — simple and stateless for us.
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

const PROTOCOL = "2025-06-18";

export class McpError extends Error {}

class Session {
  private sessionId: string | null = null;
  private nextId = 1;
  constructor(private readonly url: string, private readonly token: string | null) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL,
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
  }

  async notify(method: string, params?: unknown) {
    await fetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(15_000) }).then((r) => r.body?.cancel());
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const res = await fetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(60_000) });
    if (res.status === 401 || res.status === 403) throw new McpError(`MCP server rejected the credentials (HTTP ${res.status})`);
    if (res.status === 404 && this.sessionId) throw new McpError("MCP session expired");
    if (!res.ok) throw new McpError(`MCP server error HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    this.sessionId = res.headers.get("mcp-session-id") ?? this.sessionId;
    const type = res.headers.get("content-type") ?? "";
    let msg: { id?: number; result?: T; error?: { message: string; code: number } } | undefined;
    if (type.includes("text/event-stream")) {
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const parsed = JSON.parse(data);
        if (parsed.id === id) msg = parsed;
      }
    } else {
      msg = (await res.json()) as typeof msg;
    }
    if (!msg) throw new McpError("MCP server sent no response");
    if (msg.error) throw new McpError(`MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg.result as T;
  }

  async open() {
    const r = await this.request<{ protocolVersion: string; serverInfo?: { name: string } }>("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "anvita", version: "1.0.0" } });
    await this.notify("notifications/initialized");
    return r;
  }
}

export async function listMcpTools(url: string, token: string | null): Promise<{ serverName: string | null; tools: McpTool[] }> {
  if (/\/sse\/?$/.test(new URL(url).pathname)) throw new McpError("This looks like a legacy SSE endpoint; use the server's Streamable HTTP URL (usually /mcp)");
  const s = new Session(url, token);
  const info = await s.open();
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await s.request<{ tools: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {});
    tools.push(...r.tools);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return { serverName: info.serverInfo?.name ?? null, tools };
}

export async function callMcpTool(url: string, token: string | null, name: string, args: Record<string, unknown>) {
  const s = new Session(url, token);
  await s.open();
  const r = await s.request<{ content?: { type: string; text?: string; [k: string]: unknown }[]; structuredContent?: unknown; isError?: boolean }>("tools/call", { name, arguments: args });
  const text = (r.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  if (r.isError) throw new McpError(text || "MCP tool reported an error");
  return { text: text.slice(0, 20_000), structured: r.structuredContent ?? null };
}
