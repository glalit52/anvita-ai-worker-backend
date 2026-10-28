import type { WorkerEdge, WorkerNode } from "../db/schema.js";
import type { Registry } from "../runtime/tools/registry.js";
import { checkExpr, ExprError, templateExprs } from "./expr.js";
import { parseOutputSpec } from "./schema.js";

export interface Issue {
  nodeId: string | null;
  level: "error" | "warning";
  message: string;
}

const KINDS = new Set(["trigger", "agent", "tool", "code", "branch", "map", "approval", "call_worker", "send", "handoff", "kb", "end"]);
const CHANNELS = new Set(["reply", "same channel", "slack", "whatsapp", "gmail", "outlook", "teams", "webhook"]);

/**
 * Static checks for a workflow graph: structure (ids, edges, cycles, reachability) and each step's
 * configuration (actions exist, expressions parse, required inputs are mapped, apps connected).
 * Errors block publishing; warnings are shown in the Studio.
 */
export function validateWorkflow(graph: { nodes: WorkerNode[]; edges: WorkerEdge[] }, opts: { registry?: Registry; connectedApps?: Set<string>; workerIds?: Set<string>; selfId?: string } = {}): Issue[] {
  const issues: Issue[] = [];
  const err = (nodeId: string | null, message: string) => issues.push({ nodeId, level: "error", message });
  const warn = (nodeId: string | null, message: string) => issues.push({ nodeId, level: "warning", message });
  const { nodes, edges } = graph;
  if (!nodes.length) {
    err(null, "Add at least one step");
    return issues;
  }

  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) err(n.id, `Duplicate step id "${n.id}"`);
    ids.add(n.id);
    if (!KINDS.has(n.kind)) err(n.id, `Unknown step type "${n.kind}"`);
  }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) err(null, `Connection ${e.id} points to a missing step`);
    if (e.source === e.target) err(e.source, "A step can't connect to itself");
  }

  // Cycles (Kahn's algorithm).
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) if (ids.has(e.target) && ids.has(e.source)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of edges.filter((x) => x.source === id)) {
      indeg.set(e.target, (indeg.get(e.target) ?? 0) - 1);
      if (indeg.get(e.target) === 0) queue.push(e.target);
    }
  }
  if (order.length < nodes.length) err(null, `The flow has a loop (${nodes.filter((n) => !order.includes(n.id)).map((n) => n.title).slice(0, 3).join(", ")}). Use a Loop / Map step to repeat work instead.`);

  const entries = nodes.filter((n) => !edges.some((e) => e.target === n.id));
  if (!entries.some((n) => n.kind === "trigger")) warn(null, "No trigger step: runs start from the steps without incoming connections");
  if (nodes.filter((n) => n.kind === "trigger").length > 1) warn(null, "More than one trigger: all of them run at the start");
  for (const n of entries) if (n.kind !== "trigger" && nodes.length > 1 && edges.some((e) => e.source === n.id) === false) warn(n.id, `“${n.title}” isn't connected to anything`);

  const ancestors = (id: string) => {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of edges.filter((x) => x.target === cur)) if (!seen.has(e.source)) seen.add(e.source), stack.push(e.source);
    }
    return seen;
  };

  for (const n of nodes) {
    const cfg = (n.config ?? {}) as Record<string, unknown>;
    const out = edges.filter((e) => e.source === n.id);
    const exprCheck = (src: unknown, what: string) => {
      for (const e of templateExprs(src)) {
        try {
          checkExpr(e);
        } catch (x) {
          err(n.id, `${what}: {{ ${e} }} — ${(x as ExprError).message}`);
          continue;
        }
        const ref = /^steps\.([\p{L}\p{N}_]+)/u.exec(e)?.[1];
        if (ref && ids.has(ref) && !ancestors(n.id).has(ref)) warn(n.id, `${what} uses steps.${ref}, which doesn't run before “${n.title}”`);
      }
    };
    for (const [k, v] of Object.entries(cfg)) if (!["code", "rules", "condition", "instructions"].includes(k)) exprCheck(v, k === "message" ? "Message" : k);

    switch (n.kind) {
      case "agent": {
        if (cfg.output !== undefined && cfg.output !== "" && !parseOutputSpec(cfg.output)) err(n.id, "Output schema should be a JSON object template or a list of field names");
        if (!cfg.instructions && !n.subtitle) warn(n.id, `Give “${n.title}” instructions so the AI knows what to do`);
        exprCheck(cfg.instructions, "Instructions");
        for (const app of Array.isArray(cfg.tools) ? (cfg.tools as string[]) : []) if (opts.connectedApps && !["sandbox", "code", "kb", "anvita", "handoff", "web"].includes(app) && !opts.connectedApps.has(app)) warn(n.id, `${app} isn't connected yet — the run will ask for it`);
        break;
      }
      case "tool": {
        const action = typeof cfg.action === "string" ? cfg.action.trim() : "";
        const tool = action ? opts.registry?.find(action) : opts.registry?.tools.find((t) => t.appId === n.appId && t.kind === "tool");
        if (!action && !n.appId) err(n.id, `Choose an app and action for “${n.title}”`);
        else if (opts.registry && !tool) err(n.id, action ? `Unknown action “${action}”` : `No actions available for ${n.appId}`);
        if (tool) {
          if (tool.needsConnection && opts.connectedApps && !opts.connectedApps.has(tool.appId)) warn(n.id, `${tool.appId} isn't connected yet — the run will ask for it`);
          const given = new Set(Object.keys(cfg).map((k) => k.replace(/^input\./, "")));
          if (cfg.input && typeof cfg.input === "object") for (const k of Object.keys(cfg.input)) given.add(k);
          const missing = (tool.inputSchema.required ?? []).filter((k) => !given.has(k));
          if (missing.length) (cfg.autoInput === false ? err : warn)(n.id, `Inputs not mapped: ${missing.join(", ")}${cfg.autoInput === false ? "" : " (AI will fill them from earlier steps)"}`);
        }
        break;
      }
      case "code":
        if (!cfg.code || !String(cfg.code).trim()) warn(n.id, `“${n.title}” has no code yet — AI will write and run it at run time`);
        break;
      case "branch": {
        const rules = Array.isArray(cfg.rules) ? (cfg.rules as string[]) : [];
        for (const r of rules) {
          const body = /^\s*[\p{L}\p{N}_ -]{1,40}?\s*:\s*(.+)$/u.exec(r)?.[1] ?? r;
          if (/^\s*(else|otherwise|default)\s*$/i.test(body) || cfg.mode === "ai") continue;
          try {
            checkExpr(body);
          } catch (x) {
            err(n.id, `Rule “${r}”: ${(x as ExprError).message}`);
          }
        }
        if (out.length < 2) warn(n.id, `“${n.title}” has fewer than two paths`);
        if (out.some((e) => !e.label) && out.length > 1 && cfg.mode !== "ai") warn(n.id, "Label each path out of a Branch with its route (e.g. yes / no / refund)");
        break;
      }
      case "map":
        if (!cfg.items) err(n.id, `Set which list “${n.title}” loops over (e.g. {{ steps.t1.rows }})`);
        break;
      case "approval":
        if (typeof cfg.condition === "string" && cfg.condition.trim() && !/^always$/i.test(cfg.condition.trim())) {
          try {
            checkExpr(cfg.condition.replace(/\?+$/, ""));
          } catch (x) {
            err(n.id, `Condition: ${(x as ExprError).message}`);
          }
        }
        break;
      case "call_worker": {
        const ref = String(cfg.workerId ?? cfg.worker ?? "");
        if (!ref) err(n.id, `Choose which Worker “${n.title}” calls`);
        else if (opts.selfId && ref === opts.selfId) err(n.id, "A Worker can't call itself");
        else if (opts.workerIds && !opts.workerIds.has(ref)) warn(n.id, `Worker “${ref}” wasn't found`);
        break;
      }
      case "send": {
        const ch = String(cfg.channel ?? n.appId ?? "reply").toLowerCase();
        if (!CHANNELS.has(ch)) err(n.id, `Unsupported channel “${ch}”`);
        if (ch === "webhook" && !cfg.url) err(n.id, "Set the webhook URL");
        if (!["reply", "same channel", "webhook"].includes(ch) && !cfg.to && !/#[\w-]+|@|\+?\d{10}/.test(`${n.title} ${n.subtitle ?? ""}`)) warn(n.id, `Set who “${n.title}” sends to`);
        if (opts.connectedApps && !["reply", "same channel", "webhook"].includes(ch) && !opts.connectedApps.has(ch)) warn(n.id, `${ch} isn't connected yet — the run will ask for it`);
        break;
      }
    }
  }
  return issues;
}
