import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { appById } from "../../catalog/index.js";
import { db } from "../../db/client.js";
import { artifacts, memories } from "../../db/schema.js";
import { newId } from "../../lib/ids.js";
import { searchKnowledge } from "../../services/knowledge.js";
import { demoData } from "./demo-data.js";
import { slackPostMessage } from "./slack.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

const str = (description: string) => ({ type: "string", description });
const appName = (id: string) => appById[id]?.name ?? id;

function emailDomain(addr: string) {
  return addr.split("@")[1]?.toLowerCase().trim() ?? "";
}

/** Runs an app action through the connector layer: a live driver when one exists and credentials are present, otherwise the demo driver. */
async function runConnector(action: string, input: Record<string, unknown>, ctx: ToolContext, summarize: (out: Record<string, unknown>) => string): Promise<ToolResult> {
  let output: Record<string, unknown>;
  if (action === "slack.post_message" && typeof ctx.credentials?.botToken === "string") {
    output = await slackPostMessage(ctx.credentials.botToken, String(input.channel), String(input.text));
  } else {
    output = demoData(action, input);
  }
  return { output, summary: summarize(output), credits: 2 };
}

function readTool(o: { name: string; action: string; appId: string; description: string; properties: Record<string, unknown>; required?: string[]; label: string; summary: (out: Record<string, unknown>) => string }): ToolDef {
  return {
    name: o.name,
    action: o.action,
    appId: o.appId,
    kind: "tool",
    description: o.description,
    inputSchema: { type: "object", properties: o.properties, required: o.required ?? [] },
    sideEffect: "none",
    needsConnection: true,
    label: () => o.label,
    execute: (input, ctx) => runConnector(o.action, input, ctx, o.summary),
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "share_plan",
    action: "anvita.plan",
    appId: "anvita",
    kind: "plan",
    description: "Share a short plan (2-6 plain-language steps) with the user before doing multi-step work. Call it once, first, for any task that needs other tools.",
    inputSchema: { type: "object", properties: { steps: { type: "array", items: { type: "string" }, description: "Plan steps" } }, required: ["steps"] },
    sideEffect: "none",
    needsConnection: false,
    label: () => "Planned the work",
    execute: async (input: { steps: string[] }) => ({ output: { ok: true, steps: input.steps.length }, summary: `${input.steps.length} steps`, credits: 0 }),
  },
  {
    name: "kb_search",
    action: "kb.search",
    appId: "anvita",
    kind: "kb",
    description: "Search the workspace knowledge bases (policies, help articles, SOPs, uploaded files). Returns cited passages.",
    inputSchema: { type: "object", properties: { query: str("What to look for") }, required: ["query"] },
    sideEffect: "none",
    needsConnection: false,
    label: (i: { query: string }) => `Searched knowledge for “${i.query.slice(0, 48)}”`,
    execute: async (input: { query: string }, ctx) => {
      const hits = await searchKnowledge(ctx.workspaceId, input.query, { limit: 6 });
      return {
        output: { results: hits.map((h) => ({ source: h.title, passage: h.content.slice(0, 1500) })) },
        summary: hits.length ? `${hits.length} passages` : "No matches",
        credits: 1,
        sources: [...new Map(hits.map((h) => [h.title, { title: h.title, appId: "anvita" }])).values()],
      };
    },
  },
  {
    name: "memory_search",
    action: "memory.read",
    appId: "anvita",
    kind: "kb",
    description: "Look up what Anvita has learned about this workspace (facts, preferences, glossary, people, processes).",
    inputSchema: { type: "object", properties: { query: str("Keywords") }, required: ["query"] },
    sideEffect: "none",
    needsConnection: false,
    label: () => "Checked memory",
    execute: async (input: { query: string }, ctx) => {
      const words = (input.query.match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 6);
      const rows = words.length
        ? await db.select().from(memories).where(and(eq(memories.workspaceId, ctx.workspaceId), or(...words.map((w) => ilike(memories.content, `%${w}%`))))).orderBy(desc(memories.uses)).limit(8)
        : [];
      if (rows.length) await db.update(memories).set({ uses: sql`${memories.uses} + 1`, lastUsedAt: new Date() }).where(sql`${memories.id} in ${rows.map((r) => r.id)}`);
      return { output: { memories: rows.map((r) => ({ type: r.type, content: r.content })) }, summary: `${rows.length} memories`, credits: 0 };
    },
  },
  {
    name: "memory_save",
    action: "memory.write",
    appId: "anvita",
    kind: "kb",
    description: "Remember a durable fact or preference the user stated (e.g. 'reports go to #growth', 'FY starts in April'). Do not store secrets or personal data.",
    inputSchema: { type: "object", properties: { content: str("The fact, one sentence"), type: { type: "string", enum: ["fact", "preference", "glossary", "person", "process"] } }, required: ["content"] },
    sideEffect: "write",
    needsConnection: false,
    label: () => "Saved to memory",
    execute: async (input: { content: string; type?: string }, ctx) => {
      await db.insert(memories).values({ id: newId("mem"), workspaceId: ctx.workspaceId, scope: "workspace", type: (input.type as "fact") ?? "fact", content: input.content.slice(0, 500), source: `Learned in chat (${ctx.onBehalfOf.name})`, sourceRunId: ctx.runId });
      return { output: { saved: true }, summary: input.content.slice(0, 60), credits: 0 };
    },
  },
  {
    name: "create_artifact",
    action: "artifact.create",
    appId: "sandbox",
    kind: "code",
    description: "Create a deliverable file for the user: a report/document (markdown), a spreadsheet (CSV), a chart spec (Vega-Lite JSON), or a dashboard/app (self-contained HTML). Put the full content in `content`.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["pdf", "doc", "sheet", "chart", "dashboard", "app"] },
        title: str("File name, e.g. Weekly report.pdf"),
        subtitle: str("One-line description, e.g. 5 pages · 3 charts"),
        content: str("Full file content"),
      },
      required: ["kind", "title", "content"],
    },
    sideEffect: "write",
    needsConnection: false,
    label: (i: { title: string }) => `Built ${i.title}`,
    execute: async (input: { kind: "pdf" | "doc" | "sheet" | "chart" | "dashboard" | "app"; title: string; subtitle?: string; content: string }, ctx) => {
      const mime = { pdf: "text/markdown", doc: "text/markdown", sheet: "text/csv", chart: "application/json", dashboard: "text/html", app: "text/html" }[input.kind];
      const id = newId("art");
      await db.insert(artifacts).values({ id, workspaceId: ctx.workspaceId, runId: ctx.runId, threadId: ctx.threadId, kind: input.kind, title: input.title, subtitle: input.subtitle ?? null, mime, sizeBytes: Buffer.byteLength(input.content), content: input.content });
      return { output: { artifact_id: id, title: input.title }, summary: input.subtitle ?? input.title, credits: 5, artifactId: id };
    },
  },

  readTool({ name: "hubspot_deals_search", action: "hubspot.deals.search", appId: "hubspot", label: "Searched HubSpot deals", description: "Search HubSpot deals (pipeline, stages, amounts) for a date range or query.", properties: { query: str("Free-text filter"), range: str("e.g. last_7d, last_30d") }, summary: (o) => `${o.total ?? 0} deals` }),
  readTool({ name: "shopify_orders_search", action: "shopify.orders.search", appId: "shopify", label: "Queried Shopify orders", description: "Summarise Shopify orders, revenue, RTO and top products/cities for a range.", properties: { range: str("e.g. last_7d") }, summary: (o) => `${o.orders_last_7d ?? 0} orders` }),
  readTool({ name: "metaads_insights", action: "metaads.insights", appId: "metaads", label: "Fetched Meta Ads insights", description: "Get Meta Ads spend, ROAS and CPA by campaign.", properties: { range: str("e.g. last_7d") }, summary: (o) => `ROAS ${o.roas}` }),
  readTool({ name: "googleads_report", action: "googleads.report", appId: "googleads", label: "Fetched Google Ads report", description: "Get Google Ads spend, conversions and CPA.", properties: { range: str("e.g. last_7d") }, summary: (o) => `${o.conversions} conversions` }),
  readTool({ name: "ga4_report", action: "ga4.report", appId: "ga4", label: "Pulled Google Analytics sessions", description: "Get GA4 sessions, conversion rate and top sources.", properties: { range: str("e.g. last_7d") }, summary: (o) => `${o.sessions} sessions` }),
  readTool({ name: "zendesk_tickets_search", action: "zendesk.tickets.search", appId: "zendesk", label: "Searched Zendesk tickets", description: "Search Zendesk tickets; returns counts, CSAT and top contact reasons.", properties: { query: str("Filter") }, summary: (o) => `${o.open} open tickets` }),
  readTool({ name: "tally_vouchers_export", action: "tally.vouchers.export", appId: "tally", label: "Exported Tally vouchers", description: "Export Tally vouchers and GST summary for a period.", properties: { period: str("e.g. 2026-10") }, summary: (o) => `${o.vouchers} vouchers` }),
  readTool({ name: "gcal_events_list", action: "gcal.events.list", appId: "gcal", label: "Checked Google Calendar", description: "List upcoming calendar events.", properties: { days: { type: "number" } }, summary: (o) => `${(o.events as unknown[] | undefined)?.length ?? 0} events` }),

  {
    name: "zendesk_ticket_create",
    action: "zendesk.tickets.create",
    appId: "zendesk",
    kind: "tool",
    description: "Create a Zendesk ticket.",
    inputSchema: { type: "object", properties: { subject: str("Subject"), body: str("Description"), requester_email: str("Customer email") }, required: ["subject", "body"] },
    sideEffect: "write",
    needsConnection: true,
    label: () => "Created Zendesk ticket",
    execute: (input, ctx) => runConnector("zendesk.tickets.create", input, ctx, (o) => `Ticket #${o.ticket_id}`),
  },
  {
    name: "hubspot_deal_update",
    action: "hubspot.deals.update",
    appId: "hubspot",
    kind: "tool",
    description: "Update fields on a HubSpot deal (stage, amount, close date).",
    inputSchema: { type: "object", properties: { deal_id: str("Deal id"), deal_name: str("Deal name for display"), changes: { type: "array", items: { type: "object", properties: { field: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["field", "to"] } } }, required: ["deal_id", "changes"] },
    sideEffect: "write",
    needsConnection: true,
    label: (i: { deal_name?: string; deal_id: string }) => `Updated HubSpot deal ${i.deal_name ?? i.deal_id}`,
    facts: (i: { changes: unknown[] }) => ({ fields_changed: i.changes.length }),
    approval: (i: { deal_name?: string; deal_id: string; changes: { field: string; from?: string; to: string }[] }) => ({
      title: `Update deal: ${i.deal_name ?? i.deal_id}`,
      risk: "low",
      preview: { kind: "fields", record: `Deal · ${i.deal_name ?? i.deal_id}`, changes: i.changes.map((c) => ({ field: c.field, from: c.from ?? "—", to: c.to })) },
    }),
    execute: (input, ctx) => runConnector("hubspot.deals.update", input, ctx, () => "Deal updated"),
  },
  {
    name: "gmail_send",
    action: "gmail.send",
    appId: "gmail",
    kind: "tool",
    description: "Send an email from the user's Gmail. Always subject to workspace approval policies.",
    inputSchema: { type: "object", properties: { to: { type: "array", items: { type: "string" } }, subject: str("Subject"), body: str("Plain-text body") }, required: ["to", "subject", "body"] },
    sideEffect: "external",
    needsConnection: true,
    label: (i: { to: string[] }) => `Sent email to ${i.to.slice(0, 2).join(", ")}${i.to.length > 2 ? "…" : ""}`,
    facts: (i: { to: string[] }, ctx) => {
      const ext = i.to.filter((a) => !ctx.workspaceDomains.includes(emailDomain(a)));
      return { recipients: i.to.length, external_recipients: ext.length, recipient_domains: [...new Set(i.to.map(emailDomain))] };
    },
    approval: (i: { to: string[]; subject: string; body: string }) => ({ title: `Send email: ${i.subject.slice(0, 60)}`, risk: "medium", preview: { kind: "email", to: i.to, subject: i.subject, body: i.body } }),
    execute: (input, ctx) => runConnector("gmail.send", input, ctx, () => `Sent to ${(input.to as string[]).length} recipient(s)`),
  },
  {
    name: "slack_post_message",
    action: "slack.post_message",
    appId: "slack",
    kind: "tool",
    description: "Post a message to a Slack channel, e.g. #growth.",
    inputSchema: { type: "object", properties: { channel: str("Channel name or id"), text: str("Message (Slack mrkdwn)") }, required: ["channel", "text"] },
    sideEffect: "write",
    needsConnection: true,
    label: (i: { channel: string }) => `Posted to ${i.channel}`,
    execute: (input, ctx) => runConnector("slack.post_message", input, ctx, () => `Posted to ${input.channel}`),
  },
  {
    name: "whatsapp_send",
    action: "whatsapp.send",
    appId: "whatsapp",
    kind: "tool",
    description: "Send a WhatsApp message to one or more customers (phone numbers in E.164).",
    inputSchema: { type: "object", properties: { to: { type: "array", items: { type: "string" } }, text: str("Message") }, required: ["to", "text"] },
    sideEffect: "external",
    needsConnection: true,
    label: (i: { to: string[] }) => `Sent WhatsApp to ${i.to.length} recipient(s)`,
    facts: (i: { to: string[] }) => ({ recipients: i.to.length }),
    approval: (i: { to: string[]; text: string }) => ({ title: `Send WhatsApp to ${i.to.length} recipient(s)`, risk: i.to.length > 50 ? "high" : "medium", preview: { kind: "email", to: i.to, subject: "WhatsApp message", body: i.text } }),
    execute: (input, ctx) => runConnector("whatsapp.send", input, ctx, () => "Sent"),
  },
  {
    name: "razorpay_refund_create",
    action: "razorpay.refunds.create",
    appId: "razorpay",
    kind: "tool",
    description: "Refund a Razorpay payment. Amount in INR.",
    inputSchema: { type: "object", properties: { payment_id: str("Razorpay payment id"), amount_inr: { type: "number" }, payee: str("Customer name / UPI"), reason: str("Why") }, required: ["payment_id", "amount_inr", "reason"] },
    sideEffect: "external",
    needsConnection: true,
    label: (i: { amount_inr: number }) => `Refunded ₹${i.amount_inr.toLocaleString("en-IN")}`,
    facts: (i: { amount_inr: number }) => ({ amount: i.amount_inr }),
    approval: (i: { payment_id: string; amount_inr: number; payee?: string; reason: string }) => ({
      title: `Refund ₹${i.amount_inr.toLocaleString("en-IN")}`,
      risk: i.amount_inr > 5000 ? "high" : "medium",
      preview: { kind: "payment", payee: i.payee ?? "Customer", amount: `₹${i.amount_inr.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`, reference: `${i.payment_id} · ${i.reason}` },
    }),
    execute: (input, ctx) => runConnector("razorpay.refunds.create", input, ctx, (o) => `Refund ${o.refund_id}`),
  },
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

/** Tools whose app the workspace may use. Built-ins are always present; app tools are offered even when not connected so the agent can ask the user to connect. */
export function toolsFor(_opts: { apps?: string[] } = {}): ToolDef[] {
  if (!_opts.apps?.length) return TOOLS;
  const allowed = new Set(_opts.apps);
  return TOOLS.filter((t) => !t.needsConnection || allowed.has(t.appId));
}

export function connectionLabel(appId: string) {
  return `Waiting for you to connect ${appName(appId)}`;
}
