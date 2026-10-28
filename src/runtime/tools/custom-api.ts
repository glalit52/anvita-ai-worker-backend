import { and, eq } from "drizzle-orm";
import { operationInputSchema } from "../../connectors/openapi.js";
import { db } from "../../db/client.js";
import { customApis, type ApiOperation } from "../../db/schema.js";
import { decrypt } from "../../lib/crypto.js";
import { assertPublicUrl } from "../../lib/net.js";
import type { ToolDef } from "./types.js";

type Api = typeof customApis.$inferSelect;
const RESPONSE_LIMIT = 40_000;

/** Call one imported operation: path/query/header params, JSON body, the API's auth. */
export async function callCustomApi(api: Api, op: ApiOperation, input: Record<string, unknown>) {
  let path = op.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Anvita/1.0" };
  for (const p of op.params) {
    const v = input[p.name];
    if (v === undefined || v === null || v === "") {
      if (p.required) throw new Error(`Missing required parameter "${p.name}"`);
      continue;
    }
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(s));
    else if (p.in === "query") query.set(p.name, s);
    else headers[p.name] = s;
  }
  const secret = api.secretEnc ? decrypt(api.secretEnc) : null;
  if (secret) {
    if (api.authType === "bearer") headers.Authorization = `Bearer ${secret}`;
    else if (api.authType === "header") headers[api.authName || "X-API-Key"] = secret;
    else if (api.authType === "query") query.set(api.authName || "api_key", secret);
    else if (api.authType === "basic") headers.Authorization = `Basic ${Buffer.from(secret.includes(":") ? secret : `${secret}:`).toString("base64")}`;
  }
  const url = await assertPublicUrl(`${api.baseUrl.replace(/\/+$/, "")}${path}${query.size ? `?${query}` : ""}`);
  let body: string | undefined;
  if (input.body !== undefined && op.method !== "GET") {
    headers["Content-Type"] = "application/json";
    body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  }
  const res = await fetch(url, { method: op.method, headers, body, redirect: "error", signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  if (!res.ok) throw new Error(`${api.name} returned HTTP ${res.status}: ${(typeof data === "string" ? data : JSON.stringify(data)).slice(0, 300)}`);
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return { status: res.status, data: s.length > RESPONSE_LIMIT ? { truncated: true, preview: s.slice(0, RESPONSE_LIMIT) } : data };
}

/** Tools generated from the workspace's imported APIs: `api_<slug>_<operation>`. */
export async function customApiToolsFor(workspaceId: string): Promise<ToolDef[]> {
  const apis = await db.select().from(customApis).where(and(eq(customApis.workspaceId, workspaceId), eq(customApis.enabled, true)));
  const out: ToolDef[] = [];
  for (const api of apis) {
    for (const op of api.operations.filter((o) => o.enabled)) {
      out.push({
        name: `api_${api.slug}_${op.id}`.slice(0, 64),
        action: `api.${api.slug}.${op.id}`,
        appId: "custom_api",
        kind: "tool",
        description: `[${api.name}] ${op.method} ${op.path} — ${op.summary}`.slice(0, 1024),
        inputSchema: operationInputSchema(op),
        sideEffect: op.sideEffect,
        needsConnection: false,
        label: () => `${op.summary.slice(0, 60)} (${api.name})`,
        execute: async (input) => {
          const r = await callCustomApi(api, op, input);
          return { output: r.data, summary: `HTTP ${r.status}`, credits: 2 };
        },
      });
    }
  }
  return out;
}
