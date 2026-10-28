import type { InteractionType, Template, WorkerEdge, WorkerNode } from "../contracts/web.js";

/**
 * Executable workflow templates: every step is fully configured (real actions, mapped inputs,
 * conditions, code), so a template runs as soon as its apps are connected. Builders customise
 * from here in the Studio.
 */

export interface WorkflowTemplate {
  meta: Template;
  description: string;
  instructions: string;
  channels: string[];
  trigger: string;
  nodes: WorkerNode[];
  edges: WorkerEdge[];
}

type N = Omit<WorkerNode, "x" | "y"> & { at: [number, number] };
const node = (n: N): WorkerNode => {
  const { at, ...rest } = n;
  return { ...rest, x: 260 + at[0] * 250, y: at[1] * 130 };
};
const e = (source: string, target: string, label?: string): WorkerEdge => ({ id: `${source}-${target}`, source, target, ...(label ? { label } : {}) });

function tpl(meta: Omit<Template, "installs"> & { installs?: string }, o: { instructions?: string; channels?: string[]; trigger: string; nodes: N[]; edges: WorkerEdge[] }): WorkflowTemplate {
  return { meta: { installs: "new", ...meta }, description: meta.description, instructions: o.instructions ?? "", channels: o.channels ?? [], trigger: o.trigger, nodes: o.nodes.map(node), edges: o.edges };
}

// ─── Shared code steps ─────────────────────────────────────────────────────────

const REPORT_CODE = `# Blend ad spend, conversions and pipeline into one weekly report (PDF + chart).
import matplotlib.pyplot as plt

def num(d, *keys):
    for k in keys:
        v = (d or {}).get(k)
        if v not in (None, ""):
            return float(v)
    return 0.0

meta, gads, deals = steps.get("m1") or {}, steps.get("m2") or {}, steps.get("m3") or {}
spend = {"Meta": num(meta, "spend", "spend_inr"), "Google": num(gads, "spend", "spend_inr")}
conversions = num(meta, "purchases", "conversions") + num(gads, "conversions")
pipeline = num(deals, "pipeline_value") or sum(float(d.get("amount") or d.get("amount_inr") or 0) for d in deals.get("deals", []))
total_spend = sum(spend.values())
cac = round(total_spend / conversions, 2) if conversions else None

plt.figure(figsize=(6, 3))
plt.bar(list(spend.keys()), list(spend.values()), color=["#0866FF", "#FBBC04"])
plt.title("Ad spend by channel")
files.chart("spend_by_channel.png")

md = "\\n".join([
    "# Weekly growth report",
    f"- Ad spend: {total_spend:,.0f}",
    f"- Conversions: {conversions:,.0f}",
    f"- Blended CAC: {cac:,.0f}" if cac else "- Blended CAC: n/a",
    f"- New pipeline: {pipeline:,.0f} across {deals.get('total', 0)} deals",
])
files.pdf("Weekly Growth Report.pdf", md, title="Weekly Growth Report", images=["spend_by_channel.png"])
return {"spend": total_spend, "conversions": conversions, "cac": cac, "pipeline": pipeline, "deals": deals.get("total", 0)}
`;

const VOUCHER_CODE = `# Turn the extracted invoice into a balanced Tally purchase voucher (GST split by tax type).
inv = steps.get("a1") or {}
taxable = float(inv.get("taxable_value") or 0)
igst, cgst, sgst = (float(inv.get(k) or 0) for k in ("igst", "cgst", "sgst"))
total = float(inv.get("total") or (taxable + igst + cgst + sgst))
entries = [{"ledger": inv.get("vendor") or "Sundry Creditor", "amount": total, "debit": False},
           {"ledger": inputs.get("purchase_ledger", "Purchase @18%"), "amount": taxable, "debit": True}]
for name, amt in (("Input IGST", igst), ("Input CGST", cgst), ("Input SGST", sgst)):
    if amt:
        entries.append({"ledger": name, "amount": amt, "debit": True})
gap = round(total - taxable - igst - cgst - sgst, 2)
if abs(gap) >= 0.01:
    entries.append({"ledger": "Round Off", "amount": abs(gap), "debit": gap > 0})
return {"voucher_type": "Purchase", "date": inv.get("invoice_date"), "number": inv.get("invoice_number"),
        "party": inv.get("vendor"), "narration": f"Invoice {inv.get('invoice_number')} (PO {inv.get('po_number') or 'n/a'})", "entries": entries}
`;

const LEADS_CODE = `# Join each lead with its research result, keep the qualified ones and export a score sheet.
contacts = (steps.get("h1") or {}).get("contacts", [])
results = (steps.get("m1") or {}).get("results", [])
rows, qualified = [], []
for c, r in zip(contacts, results):
    r = r or {}
    score = float(r.get("score") or 0)
    rows.append({"name": c.get("name"), "company": c.get("company"), "email": c.get("email"), "score": score, "reason": r.get("reason")})
    if score >= float(inputs.get("min_score", 70)) and c.get("email"):
        qualified.append({"email_address": c.get("email"), "name": c.get("name"), "subject": r.get("subject"), "email": r.get("email")})
files.csv("Lead scores.csv", rows)
return {"scored": len(rows), "qualified": qualified}
`;

const RFP_CODE = `# Questions + drafted answers → Excel for the sales lead to review.
import pandas as pd
qs = (steps.get("a1") or {}).get("questions", [])
ans = (steps.get("m1") or {}).get("results", [])
df = pd.DataFrame([{"Question": q, "Answer": (a or {}).get("answer"), "Confidence": (a or {}).get("confidence"), "Sources": (a or {}).get("sources")} for q, a in zip(qs, ans)])
files.excel("RFP answers.xlsx", {"Answers": df})
needs = int((df["Confidence"] == "low").sum()) if len(df) else 0
return {"questions": len(df), "needs_sme": needs}
`;

const COLLECTIONS_CODE = `# Pair overdue invoices with their payment links and prepare WhatsApp reminder parameters.
invoices = (steps.get("z1") or {}).get("invoices", [])
links = (steps.get("m1") or {}).get("results", [])
contacts = inputs.get("phones", {})  # optional {customer: phone} map passed by the trigger
out = []
for inv, link in zip(invoices, links):
    phone = contacts.get(inv.get("customer")) or inv.get("phone")
    if not phone or not (link or {}).get("url"):
        continue
    out.append({"phone": phone, "params": [inv.get("customer"), f"₹{float(inv.get('balance') or 0):,.0f}", inv.get("number"), link["url"]]})
return {"reminders": out, "outstanding": sum(float(i.get("balance") or 0) for i in invoices)}
`;

const STOCK_CODE = `# Reorder sheet for low-stock variants.
rows = (steps.get("p1") or {}).get("variants", [])
target = float(inputs.get("target_stock", 50))
sheet = [{"Product": r.get("product"), "Variant": r.get("variant") or "", "SKU": r.get("sku"), "Stock": r.get("stock"), "Reorder qty": max(0, int(target - float(r.get("stock") or 0)))} for r in rows]
files.csv("Reorder sheet.csv", sheet)
return {"skus": len(sheet), "units_to_order": sum(s["Reorder qty"] for s in sheet)}
`;

const GST_CODE = `# GST summary by voucher type plus basic checks, exported to Excel.
import pandas as pd
data = steps.get("v1") or {}
items = data.get("items", [])
df = pd.DataFrame(items) if items else pd.DataFrame(columns=["type", "number", "date", "party", "amount", "gst"])
summary = df.groupby("type").agg(vouchers=("number", "count"), amount=("amount", "sum"), gst=("gst", "sum")).reset_index() if len(df) else df
missing_party = df[df["party"].fillna("") == ""] if len(df) else df
files.excel("GST summary.xlsx", {"Summary": summary, "Vouchers": df, "Missing party": missing_party})
return {"vouchers": len(df), "gst_total": float(df["gst"].sum()) if len(df) else 0, "missing_party": len(missing_party)}
`;

const PIPELINE_CODE = `# Pipeline by stage and a simple weighted forecast.
deals = (steps.get("h1") or {}).get("deals", [])
weights = {"appointmentscheduled": 0.2, "qualifiedtobuy": 0.4, "presentationscheduled": 0.6, "decisionmakerboughtin": 0.8, "contractsent": 0.9, "closedwon": 1.0, "closedlost": 0.0}
by_stage, forecast = {}, 0.0
for d in deals:
    stage = str(d.get("stage") or "unknown")
    amt = float(d.get("amount") or d.get("amount_inr") or 0)
    by_stage[stage] = by_stage.get(stage, 0) + amt
    forecast += amt * weights.get(stage.lower().replace(" ", ""), 0.3)
files.csv("Pipeline by stage.csv", [{"Stage": k, "Value": v} for k, v in sorted(by_stage.items(), key=lambda x: -x[1])])
return {"deals": len(deals), "pipeline": sum(by_stage.values()), "weighted_forecast": round(forecast), "by_stage": by_stage}
`;

// ─── Templates ─────────────────────────────────────────────────────────────────

const SUPPORT = tpl(
  { id: "tpl-support", name: "Customer Support Agent", description: "Resolve order, return and FAQ queries on WhatsApp, web and email with citations and human handoff.", emoji: "💬", color: "#25D366", category: "Support", apps: ["whatsapp", "shopify", "razorpay", "zendesk"], interaction: "chat", installs: "2.4k", popular: true },
  {
    channels: ["WhatsApp", "Web widget"],
    trigger: "Incoming message",
    instructions: "Be warm and concise. Never promise refunds outside the 7-day return policy.",
    nodes: [
      { id: "t1", kind: "trigger", title: "New message", subtitle: "WhatsApp · Web widget", appId: "whatsapp", at: [1, 0], config: { triggerType: "channel", languages: ["English", "Hindi", "Tamil"] } },
      { id: "a1", kind: "agent", title: "Understand request", subtitle: "Intent, sentiment, order id", at: [1, 1], config: { model: "Fast (Haiku)", instructions: "Classify the customer's latest message. Use 'human' when they ask for a person.", output: '{"intent": "order_status | return_refund | product_question | human | other", "sentiment": "positive | neutral | negative", "order_id": "string?", "language": "string"}' } },
      { id: "b1", kind: "branch", title: "Route by intent", subtitle: "4 paths", at: [1, 2], config: { rules: ["human: intent = human or sentiment = negative", "order_status: intent = order_status", "return_refund: intent = return_refund", "else"] } },
      { id: "o1", kind: "tool", title: "Look up the order", subtitle: "shopify.orders.get", appId: "shopify", at: [0, 3], config: { action: "shopify.orders.get", "input.order": "{{ order_id ?? '' }}", onError: "continue" } },
      { id: "a2", kind: "agent", title: "Write order update", subtitle: "Status + tracking", at: [0, 4], config: { model: "Fast (Haiku)", instructions: "Reply to the customer with their order status and tracking from the order lookup. If the lookup failed or no order id was given, ask for the order number politely." } },
      { id: "kb1", kind: "kb", title: "Search return policy", subtitle: "Help center & policies", at: [1, 3], config: { kb: "Help center & policies", query: "return refund policy {{ trigger.text }}", topK: 5 } },
      { id: "a3", kind: "agent", title: "Decide refund", subtitle: "Eligibility vs policy", at: [1, 4], config: { model: "Balanced (Sonnet)", instructions: "Using the policy passages and the conversation, decide if a refund is eligible and how much. Write a short reply to the customer explaining the decision.", output: '{"eligible": "boolean", "amount": "number", "payment_id": "string?", "reply": "string"}' } },
      { id: "ap1", kind: "approval", title: "Approve if > ₹5,000", subtitle: "Support lead · 4h", at: [1, 5], config: { approvers: "Role: Support lead", condition: "eligible = true and amount > 5000", timeout: "4h", onTimeout: "escalate" } },
      { id: "r1", kind: "tool", title: "Create refund", subtitle: "razorpay.refunds.create", appId: "razorpay", at: [1, 6], config: { action: "razorpay.refunds.create", "input.payment_id": "{{ steps.a3.payment_id }}", "input.amount_inr": "{{ steps.a3.amount }}", "input.reason": "Return within policy", onError: "continue" } },
      { id: "h1", kind: "handoff", title: "Hand off to human", subtitle: "Anvita Inbox · Support", at: [2, 3], config: { reason: "{{ intent = 'human' ? 'Customer asked for a person' : 'Unhappy customer — please take over' }}", summary: "{{ trigger.text }}" } },
      { id: "a4", kind: "agent", title: "Answer FAQ", subtitle: "Knowledge base + reply", at: [3, 3], config: { model: "Balanced (Sonnet)", kb: "Help center & policies", instructions: "Answer the customer's question from the knowledge passages only. If unsure, say a teammate will follow up." } },
      { id: "s1", kind: "send", title: "Reply to customer", subtitle: "Same channel", appId: "whatsapp", at: [1, 7], config: { channel: "reply" } },
      { id: "end", kind: "end", title: "Log outcome", at: [1, 8], config: { outcome: "{{ intent }}" } },
    ],
    edges: [e("t1", "a1"), e("a1", "b1"), e("b1", "h1", "human"), e("b1", "o1", "order_status"), e("b1", "kb1", "return_refund"), e("b1", "a4", "else"), e("o1", "a2"), e("a2", "s1"), e("kb1", "a3"), e("a3", "ap1"), e("a3", "s1"), e("ap1", "r1", "approved"), e("r1", "s1"), e("a4", "s1"), e("s1", "end"), e("h1", "end")],
  },
);

const REPORT = tpl(
  { id: "tpl-report", name: "Weekly Business Report", description: "Pull metrics from ads, CRM and commerce; build a PDF and post the summary to Slack.", emoji: "📈", color: "#5B4CF0", category: "Analytics", apps: ["metaads", "googleads", "hubspot", "slack"], interaction: "scheduled", installs: "1.9k", popular: true },
  {
    channels: ["Slack"],
    trigger: "Every Monday 09:00 IST",
    nodes: [
      { id: "t1", kind: "trigger", title: "Every Monday 09:00 IST", subtitle: "Schedule", at: [1, 0], config: { triggerType: "schedule", cron: "0 9 * * MON", timezone: "Asia/Kolkata" } },
      { id: "m1", kind: "tool", title: "Meta Ads insights", subtitle: "metaads.insights", appId: "metaads", at: [0, 1], config: { action: "metaads.insights", range: "{{ trigger.range ?? 'last_7d' }}" } },
      { id: "m2", kind: "tool", title: "Google Ads report", subtitle: "googleads.report", appId: "googleads", at: [1, 1], config: { action: "googleads.report", range: "{{ trigger.range ?? 'last_7d' }}" } },
      { id: "m3", kind: "tool", title: "HubSpot deals", subtitle: "hubspot.deals.search", appId: "hubspot", at: [2, 1], config: { action: "hubspot.deals.search", range: "{{ trigger.range ?? 'last_7d' }}" } },
      { id: "c1", kind: "code", title: "Build report", subtitle: "Python · PDF + chart", appId: "sandbox", at: [1, 2], config: { language: "python", file: "build_report.py", code: REPORT_CODE } },
      { id: "a1", kind: "agent", title: "Write executive summary", subtitle: "3 bullets + risks", at: [1, 3], config: { model: "Balanced (Sonnet)", instructions: "Summarise spend, CAC and pipeline vs expectations in 3 Slack-ready bullets. Flag any channel whose CAC looks out of line." } },
      { id: "ap1", kind: "approval", title: "Founder review", subtitle: "Owner · 24h", at: [1, 4], config: { approvers: "Role: Owner", timeout: "24h", onTimeout: "reject" } },
      { id: "s1", kind: "send", title: "Post to #growth", subtitle: "Slack", appId: "slack", at: [1, 5], config: { channel: "slack", to: "#growth", message: "*Weekly growth report*\n{{ steps.a1.text }}" } },
      { id: "end", kind: "end", title: "Done", at: [1, 6] },
    ],
    edges: [e("t1", "m1"), e("t1", "m2"), e("t1", "m3"), e("m1", "c1"), e("m2", "c1"), e("m3", "c1"), e("c1", "a1"), e("a1", "ap1"), e("ap1", "s1", "approved"), e("s1", "end")],
  },
);

const INVOICE = tpl(
  { id: "tpl-invoice", name: "Invoice & AP Processing", description: "Extract GST invoice fields, check them and post purchase vouchers to Tally — with finance review when confidence is low.", emoji: "🧾", color: "#0C7A5A", category: "Finance", apps: ["tally", "slack"], interaction: "queue", installs: "1.1k", popular: true },
  {
    trigger: "Invoice received",
    nodes: [
      { id: "t1", kind: "trigger", title: "Invoice received", subtitle: "Upload · email · API", at: [1, 0], config: { triggerType: "queue" } },
      { id: "a1", kind: "agent", title: "Extract invoice fields", subtitle: "GSTIN, totals, tax split", at: [1, 1], config: { model: "Precise (Opus)", instructions: "Read the attached invoice (or the invoice text in the inputs). Extract the fields exactly as printed; amounts as plain numbers in INR. Set confidence (0-1) lower when anything is unclear.", output: '{"vendor": "string", "gstin": "string?", "invoice_number": "string", "invoice_date": "string", "po_number": "string?", "taxable_value": "number", "igst": "number?", "cgst": "number?", "sgst": "number?", "total": "number", "confidence": "number"}' } },
      { id: "l1", kind: "tool", title: "Find vendor ledger", subtitle: "tally.ledgers.list", appId: "tally", at: [1, 2], config: { action: "tally.ledgers.list", query: "{{ steps.a1.vendor }}", onError: "continue" } },
      { id: "b1", kind: "branch", title: "Confident & known vendor?", at: [1, 3], config: { rules: ["yes: steps.a1.confidence >= 95% and steps.l1.total > 0", "else"] } },
      { id: "ap1", kind: "approval", title: "Finance review", subtitle: "Finance · 24h", at: [2, 4], config: { approvers: "Group: Finance", timeout: "24h", preview: { Vendor: "{{ steps.a1.vendor }}", GSTIN: "{{ steps.a1.gstin }}", Invoice: "{{ steps.a1.invoice_number }}", Total: "{{ inr(steps.a1.total) }}", Confidence: "{{ round(steps.a1.confidence * 100) }}%" } } },
      { id: "c1", kind: "code", title: "Prepare voucher", subtitle: "Balanced GST entries", appId: "sandbox", at: [1, 5], config: { language: "python", code: VOUCHER_CODE } },
      { id: "v1", kind: "tool", title: "Post purchase voucher", subtitle: "tally.vouchers.create", appId: "tally", at: [1, 6], config: { action: "tally.vouchers.create", input: "{{ steps.c1 }}" } },
      { id: "s1", kind: "send", title: "Notify #finance-ops", subtitle: "Slack", appId: "slack", at: [1, 7], config: { channel: "slack", to: "#finance-ops", message: "Posted {{ steps.a1.invoice_number }} from {{ steps.a1.vendor }} — {{ inr(steps.a1.total) }}" } },
      { id: "end", kind: "end", title: "Done", at: [1, 8], config: { outcome: "{{ steps.v1.voucher_id ?? 'posted' }}" } },
    ],
    edges: [e("t1", "a1"), e("a1", "l1"), e("l1", "b1"), e("b1", "c1", "yes"), e("b1", "ap1", "else"), e("ap1", "c1", "approved"), e("c1", "v1"), e("v1", "s1"), e("s1", "end")],
  },
);

const IT = tpl(
  { id: "tpl-it", name: "IT Helpdesk", description: "Password resets, access requests and how-to answers over Slack or Teams, with Jira tickets for everything else.", emoji: "🛠️", color: "#0284C7", category: "IT", apps: ["okta", "jira", "slack"], interaction: "chat", installs: "860" },
  {
    channels: ["Slack"],
    trigger: "Message in #it-help",
    nodes: [
      { id: "t1", kind: "trigger", title: "Message in #it-help", subtitle: "Slack", appId: "slack", at: [2, 0], config: { triggerType: "channel" } },
      { id: "a1", kind: "agent", title: "Classify request", at: [2, 1], config: { model: "Fast (Haiku)", instructions: "Classify the employee's IT request.", output: '{"category": "password_reset | access_request | how_to | other", "user_email": "string?", "app": "string?", "urgency": "low | normal | high"}' } },
      { id: "b1", kind: "branch", title: "Route", at: [2, 2], config: { rules: ["password_reset: category = password_reset", "access_request: category = access_request", "how_to: category = how_to", "else"] } },
      { id: "o1", kind: "tool", title: "Reset password", subtitle: "okta.users.reset_password", appId: "okta", at: [0, 3], config: { action: "okta.users.reset_password", user: "{{ user_email ?? trigger.email ?? '' }}" } },
      { id: "ap1", kind: "approval", title: "Manager approval", subtitle: "Admin · 24h", at: [1, 3], config: { approvers: "Role: Admin", timeout: "24h", preview: { Employee: "{{ user_email ?? trigger.author }}", Access: "{{ app }}", Reason: "{{ trigger.text }}" } } },
      { id: "o2", kind: "tool", title: "Grant access", subtitle: "okta.groups.add_user", appId: "okta", at: [1, 4], config: { action: "okta.groups.add_user", user: "{{ user_email ?? trigger.email ?? '' }}", group: "{{ app }} users" } },
      { id: "kb1", kind: "kb", title: "Search IT docs", at: [2, 3], config: { query: "{{ trigger.text }}" } },
      { id: "j1", kind: "tool", title: "Open Jira ticket", subtitle: "jira.issues.create", appId: "jira", at: [3, 3], config: { action: "jira.issues.create", project_key: "IT", summary: "{{ truncate(trigger.text, 80) }}", description: "Raised via Anvita IT Helpdesk. Urgency: {{ urgency }}", issue_type: "Task" } },
      { id: "a2", kind: "agent", title: "Write reply", at: [2, 5], config: { model: "Fast (Haiku)", instructions: "Tell the employee, in 1-3 sentences, what was done for them based on the steps above (reset email sent, access granted or pending, the answer, or the ticket number)." } },
      { id: "s1", kind: "send", title: "Reply in thread", subtitle: "Same channel", appId: "slack", at: [2, 6], config: { channel: "reply" } },
    ],
    edges: [e("t1", "a1"), e("a1", "b1"), e("b1", "o1", "password_reset"), e("b1", "ap1", "access_request"), e("b1", "kb1", "how_to"), e("b1", "j1", "else"), e("ap1", "o2", "approved"), e("ap1", "a2", "rejected"), e("o1", "a2"), e("o2", "a2"), e("kb1", "a2"), e("j1", "a2"), e("a2", "s1")],
  },
);

const SDR = tpl(
  { id: "tpl-sdr", name: "Lead Research & Outreach", description: "Research new HubSpot leads on the web, score ICP fit and draft personalised first-touch emails in Gmail.", emoji: "🎯", color: "#FF7A59", category: "Sales", apps: ["hubspot", "web", "gmail", "slack"], interaction: "scheduled", installs: "1.3k" },
  {
    channels: ["Slack"],
    trigger: "Every weekday 10:00 IST",
    nodes: [
      { id: "t1", kind: "trigger", title: "Every weekday 10:00 IST", subtitle: "Schedule", at: [1, 0], config: { triggerType: "schedule", cron: "0 10 * * MON-FRI" } },
      { id: "h1", kind: "tool", title: "New leads", subtitle: "hubspot.contacts.search", appId: "hubspot", at: [1, 1], config: { action: "hubspot.contacts.search", range: "{{ trigger.range ?? 'last_1d' }}", limit: 25 } },
      { id: "m1", kind: "map", title: "Research & score each lead", subtitle: "Web research · ICP score", at: [1, 2], config: { items: "{{ steps.h1.contacts }}", mode: "agent", concurrency: 3, max: 25, tools: ["web"], model: "Balanced (Sonnet)", instructions: "Research {{ item.company }} ({{ item.website ?? '' }}) and {{ item.name }}, {{ item.title }}. Score fit 0-100 for our ICP (Indian consumer brands and enterprises buying corporate gifts). Draft a 90-word first-touch email referencing one specific fact you found.", output: '{"score": "number", "reason": "string", "subject": "string", "email": "string"}' } },
      { id: "c1", kind: "code", title: "Pick qualified leads", subtitle: "Score sheet CSV", appId: "sandbox", at: [1, 3], config: { language: "python", code: LEADS_CODE } },
      { id: "m2", kind: "map", title: "Draft emails in Gmail", subtitle: "gmail.drafts.create", at: [1, 4], config: { items: "{{ steps.c1.qualified }}", mode: "tool", action: "gmail.drafts.create", "input.to": ["{{ item.email_address }}"], "input.subject": "{{ item.subject }}", "input.body": "{{ item.email }}" } },
      { id: "s1", kind: "send", title: "Post to #sales", subtitle: "Slack", appId: "slack", at: [1, 5], config: { channel: "slack", to: "#sales", message: "{{ len(steps.c1.qualified) }} of {{ steps.c1.scored }} new leads look like a fit — personalised drafts are waiting in Gmail." } },
    ],
    edges: [e("t1", "h1"), e("h1", "m1"), e("m1", "c1"), e("c1", "m2"), e("m2", "s1")],
  },
);

const ONBOARD = tpl(
  { id: "tpl-onboard", name: "Employee Onboarding", description: "Spot new joiners in Darwinbox, grant their team's access in Okta, welcome them on Slack and brief People Ops.", emoji: "🧑‍💼", color: "#7C3AED", category: "HR", apps: ["darwinbox", "okta", "slack"], interaction: "scheduled", installs: "640" },
  {
    trigger: "Every day 10:00 IST",
    nodes: [
      { id: "t1", kind: "trigger", title: "Every day 10:00 IST", subtitle: "Schedule", at: [1, 0], config: { triggerType: "schedule", cron: "0 10 * * *" } },
      { id: "d1", kind: "tool", title: "New joiners", subtitle: "darwinbox.employees.search", appId: "darwinbox", at: [1, 1], config: { action: "darwinbox.employees.search", joined_after: "{{ trigger.since ?? days_ago(1) }}" } },
      { id: "b1", kind: "branch", title: "Anyone new?", at: [1, 2], config: { rules: ["yes: steps.d1.total > 0", "else"] } },
      { id: "m1", kind: "map", title: "Grant team access", subtitle: "okta.groups.add_user", at: [0, 3], config: { items: "{{ steps.d1.employees }}", mode: "tool", action: "okta.groups.add_user", "input.user": "{{ item.email }}", "input.group": "{{ item.department }}", onError: "continue" } },
      { id: "m2", kind: "map", title: "Welcome on Slack", subtitle: "#general", at: [2, 3], config: { items: "{{ steps.d1.employees }}", mode: "tool", action: "slack.post_message", "input.channel": "#general", "input.text": "Please welcome {{ item.name }} — joining {{ item.department }} as {{ item.designation ?? 'a new teammate' }} 🎉" } },
      { id: "a1", kind: "agent", title: "Brief People Ops", at: [1, 4], config: { model: "Fast (Haiku)", instructions: "Summarise today's joiners and anything that failed (e.g. access not granted) as a short checklist for People Ops." } },
      { id: "s1", kind: "send", title: "Post to #people-ops", appId: "slack", at: [1, 5], config: { channel: "slack", to: "#people-ops", message: "{{ steps.a1.text }}" } },
    ],
    edges: [e("t1", "d1"), e("d1", "b1"), e("b1", "m1", "yes"), e("b1", "m2", "yes"), e("m1", "a1"), e("m2", "a1"), e("a1", "s1")],
  },
);

const RFP = tpl(
  { id: "tpl-rfp", name: "RFP / Security Questionnaire", description: "Answer RFPs and vendor security questionnaires from your policies and past responses; export to Excel for review.", emoji: "📋", color: "#DB2777", category: "Sales", apps: ["gdrive", "notion"], interaction: "document", installs: "520" },
  {
    trigger: "Questionnaire uploaded",
    nodes: [
      { id: "t1", kind: "trigger", title: "Questionnaire uploaded", subtitle: "Chat or API", at: [1, 0], config: { triggerType: "api" } },
      { id: "a1", kind: "agent", title: "Extract questions", at: [1, 1], config: { model: "Balanced (Sonnet)", instructions: "List every question in the attached questionnaire (or the text in the inputs), in order, verbatim.", output: '{"questions": "list of strings"}' } },
      { id: "m1", kind: "map", title: "Draft each answer", subtitle: "Knowledge base · citations", at: [1, 2], config: { items: "{{ steps.a1.questions }}", mode: "agent", concurrency: 4, max: 300, kb: "", tools: ["kb"], model: "Balanced (Sonnet)", instructions: "Answer this question for our company using only the knowledge base: {{ item }}. Be specific and concise. If the knowledge base doesn't cover it, answer 'Needs SME input' with confidence low.", output: '{"answer": "string", "confidence": "high | medium | low", "sources": "string?"}' } },
      { id: "c1", kind: "code", title: "Build answer sheet", subtitle: "Excel", appId: "sandbox", at: [1, 3], config: { language: "python", code: RFP_CODE } },
      { id: "ap1", kind: "approval", title: "Sales lead review", at: [1, 4], config: { approvers: "Role: Builder", timeout: "48h", preview: { Questions: "{{ steps.c1.questions }}", "Need SME input": "{{ steps.c1.needs_sme }}" } } },
      { id: "s1", kind: "send", title: "Reply with the sheet", at: [1, 5], config: { channel: "reply", message: "Drafted {{ steps.c1.questions }} answers — {{ steps.c1.needs_sme }} need SME input. The Excel is attached above." } },
    ],
    edges: [e("t1", "a1"), e("a1", "m1"), e("m1", "c1"), e("c1", "ap1"), e("ap1", "s1", "approved")],
  },
);

const RECRUIT = tpl(
  { id: "tpl-recruit", name: "Recruiter Screening", description: "Screen résumés against the JD, propose an interview slot from the recruiter's calendar and send the invite after a quick confirm.", emoji: "🤝", color: "#0D9488", category: "HR", apps: ["gcal", "slack"], interaction: "queue", installs: "410" },
  {
    trigger: "Résumé received",
    nodes: [
      { id: "t1", kind: "trigger", title: "Résumé received", subtitle: "Upload · API", at: [1, 0], config: { triggerType: "queue" } },
      { id: "a1", kind: "agent", title: "Screen against JD", at: [1, 1], config: { model: "Balanced (Sonnet)", instructions: "Compare the attached résumé with the job description in the inputs (trigger.jd). Score 0-100 and recommend.", output: '{"name": "string", "email": "string?", "score": "number", "strengths": "string", "gaps": "string", "recommendation": "advance | hold | reject"}' } },
      { id: "b1", kind: "branch", title: "Advance?", at: [1, 2], config: { rules: ["yes: recommendation = advance and score >= 70", "else"] } },
      { id: "f1", kind: "tool", title: "Check recruiter calendar", subtitle: "gcal.freebusy", appId: "gcal", at: [0, 3], config: { action: "gcal.freebusy", days: 5 } },
      { id: "a2", kind: "agent", title: "Pick a slot", at: [0, 4], config: { model: "Fast (Haiku)", instructions: "Pick the earliest free 45-minute slot on a weekday between 10:00 and 17:00 IST from the busy times. Return ISO times with +05:30.", output: '{"start": "string", "end": "string"}' } },
      { id: "ap1", kind: "approval", title: "Recruiter confirms", at: [0, 5], config: { approvers: "Role: Member", timeout: "24h", preview: { Candidate: "{{ steps.a1.name }} ({{ steps.a1.score }})", Slot: "{{ steps.a2.start }}", Strengths: "{{ steps.a1.strengths }}" } } },
      { id: "e1", kind: "tool", title: "Send interview invite", subtitle: "gcal.events.create", appId: "gcal", at: [0, 6], config: { action: "gcal.events.create", title: "Interview: {{ steps.a1.name }}", start: "{{ steps.a2.start }}", end: "{{ steps.a2.end }}", "input.attendees": ["{{ steps.a1.email }}"] } },
      { id: "s1", kind: "send", title: "Update #hiring", appId: "slack", at: [2, 3], config: { channel: "slack", to: "#hiring", message: "{{ steps.a1.name }}: {{ steps.a1.recommendation }} ({{ steps.a1.score }}/100). Gaps: {{ steps.a1.gaps }}" } },
    ],
    edges: [e("t1", "a1"), e("a1", "b1"), e("b1", "f1", "yes"), e("b1", "s1", "else"), e("f1", "a2"), e("a2", "ap1"), e("ap1", "e1", "approved")],
  },
);

const COLLECTIONS = tpl(
  { id: "tpl-collections", name: "Payment Collections", description: "Polite WhatsApp reminders for overdue Zoho Books invoices with UPI payment links, after finance approves the batch.", emoji: "💸", color: "#0C2451", category: "Finance", apps: ["zoho", "razorpay", "whatsapp", "slack"], interaction: "scheduled", installs: "730" },
  {
    trigger: "Weekdays 11:00 IST",
    nodes: [
      { id: "t1", kind: "trigger", title: "Weekdays 11:00 IST", subtitle: "Schedule", at: [1, 0], config: { triggerType: "schedule", cron: "0 11 * * MON-FRI" } },
      { id: "z1", kind: "tool", title: "Overdue invoices", subtitle: "zoho.books.invoices.list", appId: "zoho", at: [1, 1], config: { action: "zoho.books.invoices.list", status: "overdue" } },
      { id: "m1", kind: "map", title: "Create UPI pay links", subtitle: "razorpay.payment_links.create", at: [1, 2], config: { items: "{{ steps.z1.invoices }}", mode: "tool", max: 50, action: "razorpay.payment_links.create", "input.amount_inr": "{{ item.balance }}", "input.description": "Invoice {{ item.number }}", "input.reference": "{{ item.number }}", "input.customer_name": "{{ item.customer }}", "input.upi": true, onError: "continue" } },
      { id: "c1", kind: "code", title: "Prepare reminders", appId: "sandbox", at: [1, 3], config: { language: "python", code: COLLECTIONS_CODE } },
      { id: "ap1", kind: "approval", title: "Finance approves batch", at: [1, 4], config: { approvers: "Group: Finance", condition: "len(steps.c1.reminders) > 0", timeout: "8h", preview: { Reminders: "{{ len(steps.c1.reminders) }}", Outstanding: "{{ inr(steps.c1.outstanding) }}" } } },
      { id: "m2", kind: "map", title: "Send WhatsApp reminders", subtitle: "Template: payment_reminder", at: [1, 5], config: { items: "{{ steps.c1.reminders }}", mode: "tool", action: "whatsapp.send_template", "input.to": ["{{ item.phone }}"], "input.template": "payment_reminder", "input.language": "en", "input.params": "{{ item.params }}", onError: "continue" } },
      { id: "s1", kind: "send", title: "Summary to #finance", appId: "slack", at: [1, 6], config: { channel: "slack", to: "#finance", message: "Collections: {{ steps.m2.count - steps.m2.failed }} reminders sent, {{ inr(steps.c1.outstanding) }} outstanding." } },
    ],
    edges: [e("t1", "z1"), e("z1", "m1"), e("m1", "c1"), e("c1", "ap1"), e("ap1", "m2", "approved"), e("m2", "s1")],
  },
);

const COD = tpl(
  { id: "tpl-cod", name: "COD Confirmation (RTO Prevention)", description: "Confirm cash-on-delivery orders on WhatsApp right after checkout to cut RTO, and tag the order in Shopify.", emoji: "📦", color: "#5E8E3E", category: "Commerce", apps: ["shopify", "whatsapp"], interaction: "api", popular: true },
  {
    trigger: "Shopify order webhook",
    nodes: [
      { id: "t1", kind: "trigger", title: "New Shopify order", subtitle: "Webhook", appId: "shopify", at: [1, 0], config: { triggerType: "app_event" } },
      { id: "o1", kind: "tool", title: "Get order", subtitle: "shopify.orders.get", appId: "shopify", at: [1, 1], config: { action: "shopify.orders.get", order: "{{ trigger.name ?? trigger.order_number ?? trigger.id }}" } },
      { id: "b1", kind: "branch", title: "Cash on delivery?", at: [1, 2], config: { rules: ["yes: steps.o1.gateway contains 'cash' or steps.o1.gateway contains 'cod'", "else"] } },
      { id: "w1", kind: "tool", title: "Ask to confirm on WhatsApp", subtitle: "Template: cod_confirmation", appId: "whatsapp", at: [0, 3], config: { action: "whatsapp.send_template", "input.to": ["{{ steps.o1.customer.phone }}"], template: "cod_confirmation", language: "en", "input.params": ["{{ steps.o1.ship_to.name ?? 'there' }}", "{{ steps.o1.order }}", "{{ inr(steps.o1.total) }}"] } },
      { id: "end", kind: "end", title: "Done", at: [1, 4], config: { outcome: "{{ steps.b1.route }}" } },
    ],
    edges: [e("t1", "o1"), e("o1", "b1"), e("b1", "w1", "yes"), e("b1", "end", "else"), e("w1", "end")],
  },
);

const TRIAGE = tpl(
  { id: "tpl-triage", name: "Support Ticket Triage", description: "Every 30 minutes, prioritise and tag new Zendesk tickets and leave an internal note with a suggested reply.", emoji: "🗂️", color: "#03363D", category: "Support", apps: ["zendesk"], interaction: "scheduled" },
  {
    trigger: "Every 30 minutes",
    nodes: [
      { id: "t1", kind: "trigger", title: "Every 30 minutes", subtitle: "Schedule", at: [1, 0], config: { triggerType: "schedule", cron: "*/30 * * * *" } },
      { id: "z1", kind: "tool", title: "New tickets", subtitle: "zendesk.tickets.search", appId: "zendesk", at: [1, 1], config: { action: "zendesk.tickets.search", query: "status:new" } },
      { id: "m1", kind: "map", title: "Triage each ticket", subtitle: "Priority · tags · draft reply", at: [1, 2], config: { items: "{{ steps.z1.tickets }}", mode: "agent", concurrency: 4, max: 40, tools: ["zendesk"], kb: "", model: "Fast (Haiku)", instructions: "Triage Zendesk ticket {{ item.id }} “{{ item.subject }}”. Use zendesk_ticket_update once to set priority, add 1-3 tags and an internal note (public=false) with a suggested reply grounded in the knowledge base.", onError: "continue" } },
      { id: "end", kind: "end", title: "Done", at: [1, 3], config: { outcome: "{{ steps.m1.count }} tickets triaged" } },
    ],
    edges: [e("t1", "z1"), e("z1", "m1"), e("m1", "end")],
  },
);

const STOCK = tpl(
  { id: "tpl-stock", name: "Low-Stock Alert", description: "Daily check of Shopify inventory; posts a reorder sheet to Slack when SKUs run low.", emoji: "📉", color: "#B45309", category: "Commerce", apps: ["shopify", "slack"], interaction: "scheduled" },
  {
    trigger: "Every day 08:30 IST",
    nodes: [
      { id: "t1", kind: "trigger", title: "Every day 08:30 IST", subtitle: "Schedule", at: [1, 0], config: { triggerType: "schedule", cron: "30 8 * * *" } },
      { id: "p1", kind: "tool", title: "Low-stock variants", subtitle: "shopify.products.search", appId: "shopify", at: [1, 1], config: { action: "shopify.products.search", low_stock_below: "{{ trigger.threshold ?? 10 }}" } },
      { id: "b1", kind: "branch", title: "Anything low?", at: [1, 2], config: { rules: ["yes: steps.p1.total > 0", "else"] } },
      { id: "c1", kind: "code", title: "Reorder sheet", appId: "sandbox", at: [1, 3], config: { language: "python", code: STOCK_CODE } },
      { id: "s1", kind: "send", title: "Alert #ops", appId: "slack", at: [1, 4], config: { channel: "slack", to: "#ops", message: "⚠️ {{ steps.c1.skus }} SKUs are below stock threshold — {{ steps.c1.units_to_order }} units to reorder (sheet in Anvita)." } },
    ],
    edges: [e("t1", "p1"), e("p1", "b1"), e("b1", "c1", "yes"), e("c1", "s1")],
  },
);

const GST = tpl(
  { id: "tpl-gst", name: "Monthly GST Summary", description: "On the 5th, export last month's vouchers from Tally, build a GST summary workbook and send it for CFO review.", emoji: "🧮", color: "#1B4F9C", category: "Finance", apps: ["tally", "slack"], interaction: "scheduled" },
  {
    trigger: "5th of every month",
    nodes: [
      { id: "t1", kind: "trigger", title: "5th of every month", subtitle: "Schedule", at: [1, 0], config: { triggerType: "schedule", cron: "0 10 5 * *" } },
      { id: "v1", kind: "tool", title: "Export vouchers", subtitle: "tally.vouchers.export", appId: "tally", at: [1, 1], config: { action: "tally.vouchers.export", period: "{{ trigger.period ?? slice(days_ago(10), 0, 7) }}" } },
      { id: "c1", kind: "code", title: "GST workbook", appId: "sandbox", at: [1, 2], config: { language: "python", code: GST_CODE } },
      { id: "a1", kind: "agent", title: "Summarise for the CFO", at: [1, 3], config: { model: "Balanced (Sonnet)", instructions: "Summarise GST liability, voucher counts and any data-quality issues in 4 bullets." } },
      { id: "ap1", kind: "approval", title: "CFO review", at: [1, 4], config: { approvers: "Role: Owner", timeout: "72h" } },
      { id: "s1", kind: "send", title: "Post to #finance", appId: "slack", at: [1, 5], config: { channel: "slack", to: "#finance", message: "GST summary ready:\n{{ steps.a1.text }}" } },
    ],
    edges: [e("t1", "v1"), e("v1", "c1"), e("c1", "a1"), e("a1", "ap1"), e("ap1", "s1", "approved")],
  },
);

const STANDUP = tpl(
  { id: "tpl-standup", name: "Engineering Daily Digest", description: "Each weekday morning, summarise yesterday's Jira movement and open GitHub PRs into a standup digest.", emoji: "🧑‍💻", color: "#0052CC", category: "Engineering", apps: ["jira", "github", "slack"], interaction: "scheduled" },
  {
    trigger: "Weekdays 09:30 IST",
    nodes: [
      { id: "t1", kind: "trigger", title: "Weekdays 09:30 IST", subtitle: "Schedule", at: [1, 0], config: { triggerType: "schedule", cron: "30 9 * * MON-FRI" } },
      { id: "j1", kind: "tool", title: "Jira updates", subtitle: "jira.issues.search", appId: "jira", at: [0, 1], config: { action: "jira.issues.search", jql: "updated >= -1d ORDER BY updated DESC" } },
      { id: "g1", kind: "tool", title: "Open PRs", subtitle: "github.issues.search", appId: "github", at: [2, 1], config: { action: "github.issues.search", query: "{{ trigger.repo_query ?? 'is:pr is:open' }}" } },
      { id: "a1", kind: "agent", title: "Write the digest", at: [1, 2], config: { model: "Fast (Haiku)", instructions: "Write a standup digest: shipped yesterday, in progress, blocked (PRs open > 3 days or issues flagged). Use Slack formatting, max 12 lines." } },
      { id: "s1", kind: "send", title: "Post to #engineering", appId: "slack", at: [1, 3], config: { channel: "slack", to: "#engineering", message: "{{ steps.a1.text }}" } },
    ],
    edges: [e("t1", "j1"), e("t1", "g1"), e("j1", "a1"), e("g1", "a1"), e("a1", "s1")],
  },
);

const PIPELINE = tpl(
  { id: "tpl-pipeline", name: "Weekly Pipeline Review", description: "Pipeline by stage, weighted forecast and deal risks from HubSpot, posted every Friday.", emoji: "📊", color: "#FF7A59", category: "Sales", apps: ["hubspot", "slack"], interaction: "scheduled" },
  {
    trigger: "Fridays 16:00 IST",
    nodes: [
      { id: "t1", kind: "trigger", title: "Fridays 16:00 IST", subtitle: "Schedule", at: [1, 0], config: { triggerType: "schedule", cron: "0 16 * * FRI" } },
      { id: "h1", kind: "tool", title: "Open deals", subtitle: "hubspot.deals.search", appId: "hubspot", at: [1, 1], config: { action: "hubspot.deals.search", range: "last_90d" } },
      { id: "c1", kind: "code", title: "Forecast", appId: "sandbox", at: [1, 2], config: { language: "python", code: PIPELINE_CODE } },
      { id: "a1", kind: "agent", title: "Call out risks", at: [1, 3], config: { model: "Balanced (Sonnet)", instructions: "Summarise pipeline and weighted forecast, then list the 3 biggest deals at risk (stalled stage or past close date) with a suggested next step each." } },
      { id: "s1", kind: "send", title: "Post to #sales", appId: "slack", at: [1, 4], config: { channel: "slack", to: "#sales", message: "{{ steps.a1.text }}" } },
    ],
    edges: [e("t1", "h1"), e("h1", "c1"), e("c1", "a1"), e("a1", "s1")],
  },
);

const ADS_GUARD = tpl(
  { id: "tpl-ads-guard", name: "Ad Spend Guardrail", description: "Daily ROAS check on Meta Ads; when it drops below target, explain why and alert the growth team.", emoji: "🛡️", color: "#0866FF", category: "Marketing", apps: ["metaads", "slack"], interaction: "scheduled" },
  {
    trigger: "Every day 12:00 IST",
    nodes: [
      { id: "t1", kind: "trigger", title: "Every day 12:00 IST", subtitle: "Schedule", at: [1, 0], config: { triggerType: "schedule", cron: "0 12 * * *" } },
      { id: "m1", kind: "tool", title: "Yesterday's ads", subtitle: "metaads.insights", appId: "metaads", at: [1, 1], config: { action: "metaads.insights", range: "yesterday" } },
      { id: "b1", kind: "branch", title: "ROAS below target?", at: [1, 2], config: { rules: ["alert: steps.m1.roas < (trigger.target_roas ?? 2)", "else"] } },
      { id: "a1", kind: "agent", title: "Diagnose", at: [0, 3], config: { model: "Balanced (Sonnet)", instructions: "ROAS fell below target. Using the campaign breakdown, explain which campaigns drove it and recommend 2-3 concrete actions (pause, budget shift, creative refresh)." } },
      { id: "s1", kind: "send", title: "Alert #growth", appId: "slack", at: [0, 4], config: { channel: "slack", to: "#growth", message: "🚨 Meta ROAS {{ steps.m1.roas }} (target {{ trigger.target_roas ?? 2 }})\n{{ steps.a1.text }}" } },
    ],
    edges: [e("t1", "m1"), e("m1", "b1"), e("b1", "a1", "alert"), e("a1", "s1")],
  },
);

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [SUPPORT, REPORT, INVOICE, IT, SDR, ONBOARD, RFP, RECRUIT, COLLECTIONS, COD, TRIAGE, STOCK, GST, STANDUP, PIPELINE, ADS_GUARD];
export const workflowTemplateById = Object.fromEntries(WORKFLOW_TEMPLATES.map((t) => [t.meta.id, t])) as Record<string, WorkflowTemplate>;

export type { InteractionType };
