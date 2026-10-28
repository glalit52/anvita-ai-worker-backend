/**
 * Output contracts for AI steps. Builders write them as a JSON template
 * (`{"intent": "order_status | return_refund | other", "order_id": "string?"}`) or a field list
 * (`intent, sentiment, order_id`). The step must return a JSON object with those fields; values
 * ending in `?` are optional, `a | b | c` are allowed values.
 */

export interface OutputField {
  name: string;
  spec: string;
  optional: boolean;
  options?: string[];
}

export interface OutputSpec {
  fields: OutputField[];
  /** Shown to the model inside <json_schema>. */
  schemaText: string;
}

export function parseOutputSpec(raw: unknown): OutputSpec | null {
  if (raw == null) return null;
  const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
  if (!text) return null;
  let obj: Record<string, unknown> | null = null;
  if (text.startsWith("{")) {
    try {
      obj = JSON.parse(text);
    } catch {
      obj = null;
    }
  } else if (typeof raw === "object" && !Array.isArray(raw)) obj = raw as Record<string, unknown>;
  const fields: OutputField[] = [];
  if (obj) {
    for (const [name, v] of Object.entries(obj)) fields.push(field(name, typeof v === "string" ? v : JSON.stringify(v)));
  } else {
    for (const part of text.split(/[,\n]/)) {
      const m = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*(\?)?\s*(?::\s*(.+))?$/u.exec(part);
      if (m) fields.push(field(m[1], `${m[3]?.trim() ?? "string"}${m[2] ? "?" : ""}`));
    }
  }
  if (!fields.length) return null;
  const schemaText = `{\n${fields.map((f) => `  "${f.name}": ${JSON.stringify(f.spec)}`).join(",\n")}\n}`;
  return { fields, schemaText };
}

function field(name: string, spec: string): OutputField {
  const s = spec.trim();
  const optional = s.endsWith("?");
  const body = optional ? s.slice(0, -1).trim() : s;
  const options = body.includes("|") ? body.split("|").map((x) => x.trim()).filter(Boolean) : undefined;
  return { name, spec: s, optional, options };
}

/** First JSON object in a model reply (tolerates code fences and surrounding prose). */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const v = JSON.parse(c.slice(start, i + 1));
          if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

/** Problems with a returned object, e.g. ["missing intent", "sentiment must be one of …"]. */
export function checkOutput(obj: Record<string, unknown>, spec: OutputSpec): string[] {
  const problems: string[] = [];
  for (const f of spec.fields) {
    const v = obj[f.name];
    if (v === undefined || v === null || v === "") {
      if (!f.optional) problems.push(`missing "${f.name}"`);
      continue;
    }
    if (f.options && !f.options.some((o) => o.toLowerCase() === String(v).toLowerCase())) problems.push(`"${f.name}" must be one of ${f.options.join(", ")}`);
  }
  return problems;
}
