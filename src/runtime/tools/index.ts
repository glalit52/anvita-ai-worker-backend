import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { appById } from "../../catalog/index.js";
import { db } from "../../db/client.js";
import { artifacts, memories } from "../../db/schema.js";
import { newId } from "../../lib/ids.js";
import { searchKnowledge } from "../../services/knowledge.js";
import { demoData } from "./demo-data.js";
import { hasLiveDriver, runLive } from "../../connectors/index.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

const str = (description: string) => ({ type: "string", description });
const appName = (id: string) => appById[id]?.name ?? id;

function emailDomain(addr: string) {
  return addr.split("@")[1]?.toLowerCase().trim() ?? "";
}

/**
 * Run an app action through the connector layer: the live driver when the connection has
 * credentials, otherwise the clearly-labelled demo driver (so flows work before apps are set up).
 */
async function runConnector(appId: string, action: string, input: Record<string, unknown>, ctx: ToolContext, summarize: (out: Record<string, any>) => string): Promise<ToolResult> {
  const live = ctx.connection && hasLiveDriver(action);
  const output = live ? await runLive(appId, action, input, ctx.connection!) : demoData(action, input);
  return { output, summary: `${summarize(output)}${live ? "" : " · demo data"}`, credits: 2 };
}

type Summ = (out: Record<string, any>) => string;

function appTool(o: { name: string; action: string; appId: string; description: string; properties: Record<string, unknown>; required?: string[]; label: string | ((i: any) => string); summary: Summ; sideEffect?: ToolDef["sideEffect"] }): ToolDef {
  return {
    name: o.name,
    action: o.action,
    appId: o.appId,
    kind: "tool",
    description: o.description,
    inputSchema: { type: "object", properties: o.properties, required: o.required ?? [] },
    sideEffect: o.sideEffect ?? "none",
    needsConnection: true,
    label: typeof o.label === "string" ? () => o.label as string : o.label,
    execute: (input, ctx) => runConnector(o.appId, o.action, input, ctx, o.summary),
  };
}
const readTool = appTool;
const n = (v: unknown) => (Array.isArray(v) ? v.length : Number(v ?? 0));

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
  readTool({ name: "shopify_orders_search", action: "shopify.orders.search", appId: "shopify", label: "Queried Shopify orders", description: "Summarise Shopify orders, revenue, RTO and top products/cities for a range.", properties: { range: str("e.g. last_7d") }, summary: (o) => `${o.orders ?? o.orders_last_7d ?? 0} orders` }),
  readTool({ name: "metaads_insights", action: "metaads.insights", appId: "metaads", label: "Fetched Meta Ads insights", description: "Get Meta Ads spend, ROAS and CPA by campaign.", properties: { range: str("e.g. last_7d") }, summary: (o) => `ROAS ${o.roas}` }),
  readTool({ name: "googleads_report", action: "googleads.report", appId: "googleads", label: "Fetched Google Ads report", description: "Get Google Ads spend, conversions and CPA.", properties: { range: str("e.g. last_7d") }, summary: (o) => `${o.conversions} conversions` }),
  readTool({ name: "ga4_report", action: "ga4.report", appId: "ga4", label: "Pulled Google Analytics sessions", description: "Get GA4 sessions, conversion rate and top sources.", properties: { range: str("e.g. last_7d"), property_id: str("GA4 property id (optional; defaults to the connected property)") }, summary: (o) => `${o.sessions} sessions` }),
  readTool({ name: "zendesk_tickets_search", action: "zendesk.tickets.search", appId: "zendesk", label: "Searched Zendesk tickets", description: "Search Zendesk tickets; returns counts, CSAT and top contact reasons.", properties: { query: str("Filter") }, summary: (o) => `${o.count ?? o.open ?? 0} tickets` }),
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
    execute: (input, ctx) => runConnector("zendesk", "zendesk.tickets.create", input, ctx, (o) => `Ticket #${o.ticket_id}`),
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
    execute: (input, ctx) => runConnector("hubspot", "hubspot.deals.update", input, ctx, () => "Deal updated"),
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
    execute: (input, ctx) => runConnector("gmail", "gmail.send", input, ctx, () => `Sent to ${(input.to as string[]).length} recipient(s)`),
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
    execute: (input, ctx) => runConnector("slack", "slack.post_message", input, ctx, () => `Posted to ${input.channel}`),
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
    execute: (input, ctx) => runConnector("whatsapp", "whatsapp.send", input, ctx, () => "Sent"),
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
    execute: (input, ctx) => runConnector("razorpay", "razorpay.refunds.create", input, ctx, (o) => `Refund ${o.refund_id}`),
  },

  // ─── More connected-app tools ───
  readTool({ name: "gmail_search", action: "gmail.messages.search", appId: "gmail", label: "Searched Gmail", description: "Search the user's Gmail (Gmail search syntax, e.g. 'from:vendor newer_than:7d invoice').", properties: { query: str("Gmail search query"), limit: { type: "number" } }, required: ["query"], summary: (o) => `${n(o.messages)} emails` }),
  readTool({ name: "gdrive_search", action: "gdrive.files.search", appId: "gdrive", label: "Searched Google Drive", description: "Full-text search Google Drive files the user can access.", properties: { query: str("Words to find"), limit: { type: "number" } }, required: ["query"], summary: (o) => `${n(o.files)} files` }),
  readTool({ name: "gsheets_read", action: "gsheets.values.get", appId: "gsheets", label: "Read Google Sheet", description: "Read a range from a Google Sheet.", properties: { spreadsheet_id: str("Spreadsheet id from its URL"), range: str("A1 range, e.g. Sheet1!A1:F200") }, required: ["spreadsheet_id"], summary: (o) => `${n(o.rows)} rows` }),
  appTool({ name: "gsheets_append", action: "gsheets.values.append", appId: "gsheets", sideEffect: "write", label: "Appended rows to Google Sheet", description: "Append rows to a Google Sheet.", properties: { spreadsheet_id: str("Spreadsheet id"), range: str("Target sheet/range, e.g. Sheet1!A1"), rows: { type: "array", items: { type: "array", items: { type: "string" } } } }, required: ["spreadsheet_id", "rows"], summary: (o) => `${o.appended ?? 0} rows added` }),
  readTool({ name: "outlook_search", action: "outlook.messages.search", appId: "outlook", label: "Searched Outlook mail", description: "Search the user's Outlook / Microsoft 365 mailbox.", properties: { query: str("Words to find"), limit: { type: "number" } }, required: ["query"], summary: (o) => `${n(o.messages)} emails` }),
  readTool({ name: "slack_channels_list", action: "slack.channels.list", appId: "slack", label: "Listed Slack channels", description: "List public Slack channels (to find where to post).", properties: {}, summary: (o) => `${n(o.channels)} channels` }),
  readTool({ name: "salesforce_query", action: "salesforce.query", appId: "salesforce", label: "Queried Salesforce", description: "Run a read-only SOQL SELECT query against Salesforce.", properties: { soql: str("SOQL SELECT query") }, required: ["soql"], summary: (o) => `${o.total ?? 0} records` }),
  readTool({ name: "razorpay_payments_list", action: "razorpay.payments.list", appId: "razorpay", label: "Listed Razorpay payments", description: "List recent Razorpay payments with captured/failed totals.", properties: { range: str("e.g. last_7d") }, summary: (o) => `${o.count ?? 0} payments` }),
  readTool({ name: "stripe_payments_list", action: "stripe.payments.list", appId: "stripe", label: "Listed Stripe payments", description: "List recent Stripe payment intents with totals.", properties: { range: str("e.g. last_7d") }, summary: (o) => `${o.count ?? 0} payments` }),
  readTool({ name: "delhivery_track", action: "delhivery.track", appId: "delhivery", label: "Tracked Delhivery shipment", description: "Track Delhivery shipments by waybill/AWB number (comma-separate several).", properties: { waybill: str("AWB number(s)") }, required: ["waybill"], summary: (o) => `${n(o.shipments)} shipments` }),
  readTool({ name: "freshdesk_tickets_search", action: "freshdesk.tickets.search", appId: "freshdesk", label: "Searched Freshdesk tickets", description: "Search Freshdesk tickets (Freshdesk query syntax, e.g. status:2).", properties: { query: str("Query") }, summary: (o) => `${o.total ?? 0} tickets` }),
  readTool({ name: "intercom_conversations_search", action: "intercom.conversations.search", appId: "intercom", label: "Searched Intercom conversations", description: "List Intercom conversations by state.", properties: { state: { type: "string", enum: ["open", "closed", "snoozed"] } }, summary: (o) => `${o.total ?? 0} conversations` }),
  readTool({ name: "mailchimp_campaigns", action: "mailchimp.campaigns.list", appId: "mailchimp", label: "Fetched Mailchimp campaigns", description: "Recent Mailchimp campaigns with open and click rates.", properties: {}, summary: (o) => `${n(o.campaigns)} campaigns` }),
  readTool({ name: "notion_search", action: "notion.search", appId: "notion", label: "Searched Notion", description: "Search Notion pages and databases shared with Anvita.", properties: { query: str("Words to find") }, required: ["query"], summary: (o) => `${n(o.results)} pages` }),
  readTool({ name: "github_issues_search", action: "github.issues.search", appId: "github", label: "Searched GitHub", description: "Search GitHub issues and PRs (GitHub search syntax, e.g. 'repo:org/app is:open label:bug').", properties: { query: str("Search query") }, required: ["query"], summary: (o) => `${o.total ?? 0} results` }),
  appTool({ name: "github_issue_create", action: "github.issues.create", appId: "github", sideEffect: "write", label: (i: { repo: string; title: string }) => `Opened GitHub issue in ${i.repo}`, description: "Create a GitHub issue.", properties: { owner: str("Repo owner"), repo: str("Repo name"), title: str("Title"), body: str("Markdown body"), labels: { type: "array", items: { type: "string" } } }, required: ["owner", "repo", "title"], summary: (o) => `#${o.number ?? "?"}` }),
  readTool({ name: "jira_issues_search", action: "jira.issues.search", appId: "jira", label: "Searched Jira", description: "Search Jira issues with JQL.", properties: { jql: str("JQL, e.g. project = OPS AND status != Done") }, summary: (o) => `${n(o.issues)} issues` }),
  appTool({ name: "jira_issue_create", action: "jira.issues.create", appId: "jira", sideEffect: "write", label: (i: { project_key: string }) => `Created Jira issue in ${i.project_key}`, description: "Create a Jira issue.", properties: { project_key: str("Project key, e.g. OPS"), summary: str("Summary"), description: str("Description"), issue_type: str("Task, Bug, Story…") }, required: ["project_key", "summary"], summary: (o) => String(o.key ?? "created") }),
  readTool({ name: "linear_issues_search", action: "linear.issues.search", appId: "linear", label: "Searched Linear", description: "Search Linear issues.", properties: { query: str("Words to find") }, required: ["query"], summary: (o) => `${n(o.issues)} issues` }),
  readTool({ name: "okta_users_search", action: "okta.users.search", appId: "okta", label: "Looked up Okta users", description: "Find Okta users by name or email.", properties: { query: str("Name or email") }, required: ["query"], summary: (o) => `${n(o.users)} users` }),
  {
    name: "outlook_send",
    action: "outlook.send",
    appId: "outlook",
    kind: "tool",
    description: "Send an email from the user's Outlook / Microsoft 365 mailbox. Subject to workspace approval policies.",
    inputSchema: { type: "object", properties: { to: { type: "array", items: { type: "string" } }, subject: str("Subject"), body: str("Plain-text body") }, required: ["to", "subject", "body"] },
    sideEffect: "external",
    needsConnection: true,
    label: (i: { to: string[] }) => `Sent email to ${i.to.slice(0, 2).join(", ")}${i.to.length > 2 ? "…" : ""}`,
    facts: (i: { to: string[] }, ctx) => {
      const ext = i.to.filter((a) => !ctx.workspaceDomains.includes(emailDomain(a)));
      return { recipients: i.to.length, external_recipients: ext.length, recipient_domains: [...new Set(i.to.map(emailDomain))] };
    },
    approval: (i: { to: string[]; subject: string; body: string }) => ({ title: `Send email: ${i.subject.slice(0, 60)}`, risk: "medium", preview: { kind: "email", to: i.to, subject: i.subject, body: i.body } }),
    execute: (input, ctx) => runConnector("outlook", "outlook.send", input, ctx, () => `Sent to ${(input.to as string[]).length} recipient(s)`),
  },
  {
    name: "stripe_refund_create",
    action: "stripe.refunds.create",
    appId: "stripe",
    kind: "tool",
    description: "Refund a Stripe payment intent (full, or partial with amount in the payment's currency).",
    inputSchema: { type: "object", properties: { payment_id: str("PaymentIntent id (pi_…)"), amount: { type: "number" }, payee: str("Customer"), reason: str("Why") }, required: ["payment_id", "reason"] },
    sideEffect: "external",
    needsConnection: true,
    label: (i: { amount?: number }) => (i.amount ? `Refunded ${i.amount}` : "Refunded payment"),
    facts: (i: { amount?: number }) => ({ amount: i.amount ?? 0 }),
    approval: (i: { payment_id: string; amount?: number; payee?: string; reason: string }) => ({ title: `Stripe refund${i.amount ? ` of ${i.amount}` : ""}`, risk: "high", preview: { kind: "payment", payee: i.payee ?? "Customer", amount: i.amount ? String(i.amount) : "Full amount", reference: `${i.payment_id} · ${i.reason}` } }),
    execute: (input, ctx) => runConnector("stripe", "stripe.refunds.create", input, ctx, (o) => `Refund ${o.refund_id}`),
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
