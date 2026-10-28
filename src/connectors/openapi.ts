import { parse as parseYaml } from "yaml";
import type { ApiOperation } from "../db/schema.js";
import { ConnectorError } from "./types.js";

/**
 * OpenAPI 3.x / Swagger 2.0 → tool operations. Local `$ref`s are resolved (depth-limited), each
 * operation becomes one tool with its path/query/header parameters and JSON body as inputs.
 */

export interface ParsedApi {
  title: string;
  baseUrl: string | null;
  operations: ApiOperation[];
  /** Auth the spec declares, as a suggestion for the import form. */
  auth: { type: "none" | "bearer" | "header" | "query" | "basic"; name?: string };
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const MAX_OPS = 200;

export function parseSpec(text: string): Record<string, unknown> {
  const t = text.trim();
  try {
    return (t.startsWith("{") ? JSON.parse(t) : parseYaml(t, { maxAliasCount: 50 })) as Record<string, unknown>;
  } catch (e) {
    throw new ConnectorError(`Couldn't parse the spec: ${(e as Error).message}`);
  }
}

function resolver(doc: Record<string, unknown>) {
  const at = (ref: string): unknown => {
    if (!ref.startsWith("#/")) return {};
    return ref
      .slice(2)
      .split("/")
      .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), doc);
  };
  const deref = (v: unknown, depth = 0): unknown => {
    if (depth > 8 || v == null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => deref(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.$ref === "string") return deref(at(o.$ref), depth + 1);
    return Object.fromEntries(Object.entries(o).filter(([k]) => !["example", "examples", "xml", "externalDocs"].includes(k)).map(([k, x]) => [k, deref(x, depth + 1)]));
  };
  return deref;
}

const opId = (method: string, path: string, given?: unknown) =>
  (typeof given === "string" && given ? given : `${method}_${path.replace(/\{([^}]+)\}/g, "by_$1")}`)
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase()
    .slice(0, 48);

export function operationsFromSpec(doc: Record<string, unknown>): ParsedApi {
  const deref = resolver(doc);
  const info = (doc.info ?? {}) as { title?: string };
  const swagger2 = typeof doc.swagger === "string";
  if (!swagger2 && typeof doc.openapi !== "string") throw new ConnectorError("This doesn't look like an OpenAPI 3 or Swagger 2 document");
  const servers = (doc.servers as { url?: string }[] | undefined) ?? [];
  const baseUrl = swagger2 ? (doc.host ? `${((doc.schemes as string[] | undefined) ?? ["https"])[0]}://${doc.host}${doc.basePath ?? ""}` : null) : (servers.find((s) => s.url?.startsWith("https://"))?.url ?? servers[0]?.url ?? null);

  const ops: ApiOperation[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries((doc.paths ?? {}) as Record<string, Record<string, unknown>>)) {
    const shared = ((item.parameters as unknown[]) ?? []).map((p) => deref(p)) as Record<string, unknown>[];
    for (const method of METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op || op.deprecated === true) continue;
      let id = opId(method, path, op.operationId);
      while (seen.has(id)) id = `${id}_${seen.size}`;
      seen.add(id);
      const params = [...shared, ...(((op.parameters as unknown[]) ?? []).map((p) => deref(p)) as Record<string, unknown>[])]
        .filter((p) => ["path", "query", "header"].includes(String(p.in)) && !/^(authorization|content-type|accept)$/i.test(String(p.name)))
        .map((p) => ({ name: String(p.name), in: p.in as "path" | "query" | "header", required: p.in === "path" || p.required === true, description: typeof p.description === "string" ? p.description.slice(0, 300) : undefined, schema: (swagger2 ? { type: p.type ?? "string", ...(p.enum ? { enum: p.enum } : {}) } : (p.schema as Record<string, unknown>)) ?? { type: "string" } }));
      let body: Record<string, unknown> | null = null;
      if (swagger2) {
        const bp = (((op.parameters as unknown[]) ?? []).map((p) => deref(p)) as Record<string, unknown>[]).find((p) => p.in === "body");
        body = (bp?.schema as Record<string, unknown>) ?? null;
      } else {
        const content = ((deref(op.requestBody) as { content?: Record<string, { schema?: Record<string, unknown> }> } | undefined)?.content ?? {}) as Record<string, { schema?: Record<string, unknown> }>;
        body = (content["application/json"] ?? Object.values(content)[0])?.schema ?? null;
      }
      ops.push({
        id,
        method: method.toUpperCase(),
        path,
        summary: String(op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`).replace(/\s+/g, " ").slice(0, 300),
        params,
        body,
        sideEffect: method === "get" ? "none" : method === "delete" ? "destructive" : "write",
        enabled: true,
      });
      if (ops.length >= MAX_OPS) break;
    }
  }

  const schemes = (swagger2 ? doc.securityDefinitions : (doc.components as { securitySchemes?: unknown } | undefined)?.securitySchemes) as Record<string, { type?: string; scheme?: string; in?: string; name?: string }> | undefined;
  const first = Object.values(schemes ?? {})[0];
  const auth: ParsedApi["auth"] = !first
    ? { type: "none" }
    : first.type === "apiKey"
    ? { type: first.in === "query" ? "query" : "header", name: first.name }
    : first.type === "http" && first.scheme === "basic"
    ? { type: "basic" }
    : first.type === "basic"
    ? { type: "basic" }
    : { type: "bearer" };
  return { title: info.title ?? "API", baseUrl, operations: ops, auth };
}

/** JSON schema for one operation's tool input. */
export function operationInputSchema(op: ApiOperation) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of op.params) {
    properties[p.name] = { ...(p.schema ?? { type: "string" }), ...(p.description ? { description: p.description } : {}) };
    if (p.required) required.push(p.name);
  }
  if (op.body) {
    properties.body = { ...op.body, description: "JSON request body" };
    required.push("body");
  }
  return { type: "object" as const, properties, required };
}
