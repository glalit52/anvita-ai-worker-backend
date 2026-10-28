import Anthropic from "@anthropic-ai/sdk";
import { config, modelProvider } from "../config.js";
import { toolByName, type TOOLS } from "./tools/index.js";

/**
 * Model Router (architecture §4.4). All LLM calls go through `callModel`, which picks the
 * provider, applies prompt caching and streams text deltas back to the runtime.
 */

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type ContentBlock = Anthropic.Beta.BetaContentBlock;
export type ToolResultParam = Anthropic.Beta.BetaToolResultBlockParam;

export interface ModelTurn {
  model: string;
  content: ContentBlock[];
  stopReason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
}

export interface ModelCall {
  tier: "act" | "plan" | "fast";
  system: string;
  messages: MessageParam[];
  tools: typeof TOOLS;
  webSearch?: boolean;
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export function modelFor(tier: ModelCall["tier"]): string {
  return tier === "plan" ? config.MODEL_PLAN : tier === "fast" ? config.MODEL_FAST : config.MODEL_ACT;
}

let client: Anthropic | null = null;
function anthropic() {
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 10 * 60_000 });
  return client;
}

async function callAnthropic(call: ModelCall): Promise<ModelTurn> {
  const model = modelFor(call.tier);
  const tools: Anthropic.Beta.BetaToolUnion[] = call.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    // Cache the stable prefix (tools → system) — the last tool carries the breakpoint.
    ...(i === call.tools.length - 1 && !call.webSearch ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  if (call.webSearch) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5, cache_control: { type: "ephemeral" } });

  const stream = anthropic().beta.messages.stream(
    {
      model,
      max_tokens: config.AGENT_MAX_TOKENS,
      system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
      messages: call.messages,
      tools,
      output_config: { effort: "medium" },
      // Server-side refusal fallback: the API re-routes a declined request to a suitable model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
    { signal: call.signal },
  );
  if (call.onText) stream.on("text", (d) => call.onText!(d));
  const msg = await stream.finalMessage();
  return { model: msg.model, content: msg.content, stopReason: msg.stop_reason, usage: msg.usage };
}

// ─── Scripted provider ─────────────────────────────────────────────────────────

const KEYWORD_TOOLS: [RegExp, string, Record<string, unknown>][] = [
  [/\b(ads?|roas|cac|meta|campaign)/i, "metaads_insights", { range: "last_7d" }],
  [/\b(google ads|search ads)/i, "googleads_report", { range: "last_7d" }],
  [/\b(traffic|analytics|ga4|sessions|funnel)/i, "ga4_report", { range: "last_7d" }],
  [/\b(deals?|leads?|pipeline|crm|hubspot)/i, "hubspot_deals_search", { range: "last_7d" }],
  [/\b(orders?|rto|sales|shopify|returns?|sku)/i, "shopify_orders_search", { range: "last_7d" }],
  [/\b(gst|invoice|voucher|tally|ledger)/i, "tally_vouchers_export", { period: "2026-10" }],
  [/\b(tickets?|support|zendesk|csat)/i, "zendesk_tickets_search", { query: "status:open" }],
  [/\b(calendar|meeting|schedule a)/i, "gcal_events_list", { days: 7 }],
  [/\b(policy|policies|refund rules|handbook|sop|how do (i|we))/i, "kb_search", {}],
];

function firstUserText(messages: MessageParam[]): string {
  const m = messages.find((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.map((b) => (b.type === "text" ? b.text : "")).join(" ");
}

function lastUserText(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const t = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(" ");
    if (t) return t;
  }
  return "";
}

/**
 * Deterministic offline "model": same tool-use protocol as Claude, driven by keywords. Used when
 * no API key is configured (local dev, CI, demos) so every runtime path — plans, connect cards,
 * approvals, artifacts — is exercised without network access.
 */
async function callScripted(call: ModelCall): Promise<ModelTurn> {
  const text = lastUserText(call.messages) || firstUserText(call.messages);
  const assistantTurns = (() => {
    let n = 0;
    for (let i = call.messages.length - 1; i >= 0; i--) {
      const m = call.messages[i];
      if (m.role === "user" && Array.isArray(m.content) && m.content.every((b) => b.type !== "tool_result")) break;
      if (m.role === "assistant") n++;
    }
    return n;
  })();
  const available = new Set(call.tools.map((t) => t.name));
  const reads = KEYWORD_TOOLS.filter(([re, name]) => re.test(text) && available.has(name)).slice(0, 3).map(([, name, input]) => ({ name, input: name === "kb_search" ? { query: text.slice(0, 80) } : input }));
  // MCP tools: call any whose tool name the user mentions (e.g. "use get_forecast").
  for (const t of call.tools.filter((x) => x.name.startsWith("mcp_"))) {
    const raw = t.action.split(".").slice(2).join(".");
    if (raw && text.toLowerCase().includes(raw.toLowerCase())) reads.push({ name: t.name, input: "query" in (t.inputSchema.properties ?? {}) ? { query: text.slice(0, 120) } : {} });
  }
  const wantsArtifact = /(pdf|report|deck|summary|sheet|excel|xlsx|csv|chart|graph|dashboard|draft)/i.exec(text);
  const wantsEmail = /\b(email|e-mail|mail it|send it to)\b/i.test(text) && available.has("gmail_send");
  const isTask = reads.length > 0 || !!wantsArtifact || wantsEmail;

  const turns: { name: string; input: Record<string, unknown> }[][] = [];
  if (isTask) {
    const steps = [...reads.map((r) => `Get data via ${r.name.split("_")[0]}`), wantsArtifact ? `Build the ${wantsArtifact[1].toLowerCase()}` : "Write up the answer", ...(wantsEmail ? ["Send it (with your approval)"] : [])];
    turns.push([{ name: "share_plan", input: { steps } }]);
    if (reads.length) turns.push(reads);
    if (wantsArtifact) {
      const k = wantsArtifact[1].toLowerCase();
      const kind = /sheet|excel|xlsx|csv/.test(k) ? "sheet" : /chart|graph/.test(k) ? "chart" : k === "dashboard" ? "dashboard" : k === "draft" ? "doc" : "pdf";
      const title = { sheet: "Results.csv", chart: "Trend chart.json", dashboard: "Dashboard.html", doc: "Draft.md", pdf: "Report.md" }[kind];
      turns.push([{ name: "create_artifact", input: { kind, title, subtitle: "Generated by Anvita", content: `# ${title}\n\nRequest: ${text}\n\n- Key metric up 12% week over week\n- 3 anomalies flagged\n` } }]);
    }
    if (wantsEmail) {
      const to = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text)?.[0] ?? "founders@example.com";
      turns.push([{ name: "gmail_send", input: { to: [to], subject: `Results: ${text.slice(0, 48)}`, body: "Hi team,\n\nSharing the results you asked for — key points below.\n\n— Anvita" } }]);
    }
  }

  const usage = { input_tokens: Math.ceil(JSON.stringify(call.messages).length / 4) + 800, output_tokens: 120 };
  if (assistantTurns < turns.length) {
    const content = turns[assistantTurns].map((t, i) => ({ type: "tool_use", id: `toolu_scripted_${assistantTurns}_${i}_${Math.random().toString(36).slice(2, 8)}`, name: t.name, input: t.input, caller: { type: "direct" } }) as unknown as ContentBlock);
    return { model: "scripted", content, stopReason: "tool_use", usage };
  }

  const toolResults = call.messages.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []));
  const rejected = toolResults.some((r) => JSON.stringify(r).includes("rejected"));
  const answer = isTask
    ? `Done. Here's what I found:\n\n• **Top insight:** the last 7 days are up 12% vs the previous week.\n• **Watch out:** 3 items look unusual — I've flagged them${wantsArtifact ? " in the file" : " below"}.\n• **Next step:** I can keep tracking this and alert you if it moves more than 10%.${wantsEmail ? (rejected ? "\n\nOkay — I didn't send the email. The draft is saved if you change your mind." : "\n\n✅ Sent, and logged in the audit trail.") : ""}`
    : `Happy to help with that. ${text ? `You asked: “${text.slice(0, 120)}”. ` : ""}Tell me which apps or files to use and I'll get it done.`;
  for (const chunk of answer.match(/.{1,24}/gs) ?? []) call.onText?.(chunk);
  return { model: "scripted", content: [{ type: "text", text: answer, citations: null } as unknown as ContentBlock], stopReason: "end_turn", usage: { ...usage, output_tokens: Math.ceil(answer.length / 4) } };
}

export async function callModel(call: ModelCall): Promise<ModelTurn> {
  return modelProvider() === "anthropic" ? callAnthropic(call) : callScripted(call);
}

export { toolByName };
