// Demo dataset mirrored from the web app mocks (apps/web/src/lib/mock). Used only by `npm run db:seed`.
import type { Approval, AuditEvent, InboxConversation, KnowledgeBase, Member, MemoryItem, Policy, Skill, Thread } from "../../contracts/web.js";

export const currentUser = { name: "Priya Sharma", email: "priya@kesarfoods.in", role: "owner" as const };

export const workspace = {
  name: "Kesar Foods",
  plan: "Business",
  region: "India (Mumbai)",
  creditsTotal: 200000,
  creditsUsed: 128450,
  renewsOn: "Nov 01",
};

export const members: Member[] = [
  { id: "u1", name: "Priya Sharma", email: "priya@kesarfoods.in", role: "owner", status: "active", lastActive: "now", sso: true },
  { id: "u2", name: "Rahul Verma", email: "rahul@kesarfoods.in", role: "builder", status: "active", lastActive: "5 min ago", sso: true },
  { id: "u3", name: "Anita Rao", email: "anita@kesarfoods.in", role: "admin", status: "active", lastActive: "1 h ago", sso: true },
  { id: "u4", name: "Kabir Mehta", email: "kabir@kesarfoods.in", role: "builder", status: "active", lastActive: "today", sso: true },
  { id: "u5", name: "Aman Gupta", email: "aman@kesarfoods.in", role: "member", status: "active", lastActive: "yesterday", sso: true },
  { id: "u6", name: "Neha Iyer", email: "neha@kesarfoods.in", role: "member", status: "active", lastActive: "2 days ago", sso: true },
  { id: "u7", name: "Farhan Ali", email: "farhan@kesarfoods.in", role: "viewer", status: "invited", lastActive: "—" },
];

export const approvals: Approval[] = [
  {
    id: "ap-1",
    title: "Send weekly growth report to founders",
    action: "gmail.send",
    appId: "gmail",
    requestedBy: { type: "agent", name: "Anvita" },
    onBehalfOf: "Priya Sharma",
    reason: "External recipients (investors@) — policy “External email needs owner approval”",
    risk: "medium",
    createdAt: "2 min ago",
    expiresIn: "23 h",
    status: "pending",
    credits: 4,
    threadId: "t-growth",
    preview: {
      kind: "email",
      to: ["founders@kesarfoods.in", "investors@saffronvc.in"],
      subject: "Weekly growth: ROAS 3.4x (+0.3), CAC ₹412 (−6%)",
      body: "Hi all,\n\nHighlights for 20–26 Oct:\n• Blended ROAS 3.4x vs 3.1x last week; Meta carried the lift (Diwali creatives).\n• CAC down 6% to ₹412; Google Search CAC up 22% — recommend trimming generic keywords.\n• 38 new B2B deals in HubSpot (₹46.2L pipeline), 9 from the Diwali gifting campaign.\n\nFull PDF attached.\n— Anvita, on behalf of Priya",
    },
  },
  {
    id: "ap-2",
    title: "Refund ₹6,499 for order #KF-20931",
    action: "razorpay.refunds.create",
    appId: "razorpay",
    requestedBy: { type: "worker", name: "Customer Support" },
    onBehalfOf: "Customer · Meera K.",
    reason: "Refund above ₹5,000 needs support-lead approval",
    risk: "high",
    createdAt: "9 min ago",
    expiresIn: "3 h 51 m",
    status: "pending",
    credits: 2,
    preview: { kind: "payment", payee: "Meera Krishnan · UPI meera@okhdfc", amount: "₹6,499.00", reference: "Order #KF-20931 · Damaged in transit (photo verified) · within 7-day window" },
  },
  {
    id: "ap-3",
    title: "Update deal stage: Taj Hotels gifting",
    action: "hubspot.deals.update",
    appId: "hubspot",
    requestedBy: { type: "worker", name: "Lead Research SDR" },
    onBehalfOf: "Aman Gupta",
    reason: "CRM writes by Workers require record owner approval",
    risk: "low",
    createdAt: "25 min ago",
    expiresIn: "47 h",
    status: "pending",
    credits: 1,
    preview: { kind: "fields", record: "Deal · Taj Hotels — Diwali corporate gifting", changes: [ { field: "Stage", from: "Qualified", to: "Proposal sent" }, { field: "Amount", from: "₹8,00,000", to: "₹11,40,000" }, { field: "Close date", from: "15 Nov", to: "08 Nov" } ] },
  },
  {
    id: "ap-4",
    title: "Post purchase voucher — Sharma Packaging",
    action: "tally.vouchers.create",
    appId: "tally",
    requestedBy: { type: "worker", name: "Invoice Processing" },
    onBehalfOf: "Finance",
    reason: "Confidence 78% (PO quantity mismatch)",
    risk: "medium",
    createdAt: "34 min ago",
    expiresIn: "23 h",
    status: "pending",
    credits: 3,
    preview: { kind: "fields", record: "Voucher · Purchase · SPP/24-25/0912", changes: [ { field: "Party", from: "—", to: "Sharma Packaging Pvt Ltd" }, { field: "Amount", from: "—", to: "₹1,84,320" }, { field: "Ledger", from: "—", to: "Packaging Material (18%)" } ] },
  },
  { id: "ap-5", title: "Send COD confirmation template to 1,240 customers", action: "whatsapp.templates.send_bulk", appId: "whatsapp", requestedBy: { type: "worker", name: "COD Order Confirmation" }, onBehalfOf: "Rahul Verma", reason: "Bulk messages > 500 need owner approval", risk: "high", createdAt: "yesterday", expiresIn: "—", status: "rejected", decidedBy: "Priya Sharma", credits: 0, preview: { kind: "fields", record: "Template · cod_confirm_v2", changes: [ { field: "Recipients", from: "—", to: "1,240" } ] } },
  { id: "ap-6", title: "Create Jira ticket for laptop request", action: "jira.issues.create", appId: "jira", requestedBy: { type: "worker", name: "IT Helpdesk (Voice)" }, onBehalfOf: "Farhan Ali", reason: "Policy: new hardware requests", risk: "low", createdAt: "yesterday", expiresIn: "—", status: "approved", decidedBy: "Anita Rao", credits: 1, preview: { kind: "fields", record: "Issue · IT-2291", changes: [ { field: "Summary", from: "—", to: "MacBook Air for new joiner" } ] } },
];

export const threads: Thread[] = [
  {
    id: "t-growth",
    title: "Ad spend vs pipeline report",
    channel: "slack",
    channelLabel: "#growth",
    updatedAt: "2 min",
    status: "waiting",
    pinned: true,
    messages: [
      { id: "m1", role: "user", author: "Priya Sharma", time: "10:31", blocks: [{ type: "text", text: "@Anvita compare last week's Meta + Google ad spend with HubSpot deals created, make a PDF and email it to the founders and investors@saffronvc.in" }] },
      {
        id: "m2",
        role: "assistant",
        author: "Anvita",
        time: "10:31",
        blocks: [
          { type: "plan", steps: ["Pull Meta Ads + Google Ads spend for 20–26 Oct", "Fetch HubSpot deals created in the same week", "Join by campaign/UTM, compute ROAS and CAC", "Build a 4-page PDF with charts", "Email founders + investors (needs your approval)"], estimate: 1200, actual: 1092 },
          {
            type: "steps",
            steps: [
              { id: "s1", label: "Fetched Meta Ads insights", detail: "14 campaigns · ₹6.8L spend", kind: "tool", appId: "metaads", status: "done", durationMs: 2100, credits: 40 },
              { id: "s2", label: "Connected Google Ads", detail: "Authorised by Priya", kind: "auth", appId: "googleads", status: "done" },
              { id: "s3", label: "Fetched Google Ads report", detail: "9 campaigns · ₹3.1L spend", kind: "tool", appId: "googleads", status: "done", durationMs: 1800, credits: 35 },
              { id: "s4", label: "Searched HubSpot deals", detail: "38 deals · ₹46.2L", kind: "tool", appId: "hubspot", status: "done", durationMs: 900, credits: 22 },
              { id: "s5", label: "Analysed & built PDF", detail: "analysis.py · 4 charts", kind: "code", appId: "sandbox", status: "done", durationMs: 14200, credits: 610 },
              { id: "s6", label: "Wrote executive summary", kind: "llm", status: "done", durationMs: 5200, credits: 381 },
              { id: "s7", label: "Waiting for approval to send email", kind: "approval", appId: "gmail", status: "waiting" },
            ],
          },
          { type: "artifact", artifact: { id: "art-1", kind: "pdf", title: "Weekly Growth Report — 20–26 Oct.pdf", subtitle: "4 pages · 4 charts", size: "612 KB" } },
          { type: "text", text: "**Blended ROAS is 3.4x (+0.3 WoW)** and CAC fell 6% to ₹412. Meta's Diwali creatives drove most of the lift. ⚠️ Google Search CAC is up 22% — generic keywords are the culprit.\n\nI've drafted the email; it's waiting for your approval because it goes to an external address." },
          { type: "approval", approvalId: "ap-1" },
          { type: "harden", workerName: "Weekly Growth Report", status: "offered" },
        ],
      },
    ],
  },
  {
    id: "t-gst",
    title: "GST reconciliation for September",
    channel: "web",
    updatedAt: "1 h",
    status: "done",
    messages: [
      { id: "m1", role: "user", author: "Priya Sharma", time: "09:12", blocks: [{ type: "text", text: "Reconcile September purchase register in Tally with GSTR-2B and list mismatches" }] },
      {
        id: "m2",
        role: "assistant",
        author: "Anvita",
        time: "09:14",
        blocks: [
          { type: "steps", steps: [ { id: "s1", label: "Exported purchase register", detail: "Tally · 412 vouchers", kind: "tool", appId: "tally", status: "done", credits: 30 }, { id: "s2", label: "Read GSTR-2B JSON", detail: "Drive / GST / 2B_Sep.json", kind: "tool", appId: "gdrive", status: "done", credits: 12 }, { id: "s3", label: "Matched by GSTIN + invoice no.", kind: "code", appId: "sandbox", status: "done", credits: 220 } ] },
          { type: "artifact", artifact: { id: "art-2", kind: "sheet", title: "GST_Recon_Sep2026.xlsx", subtitle: "3 sheets · 17 mismatches", size: "88 KB" } },
          { type: "text", text: "Found **17 mismatches worth ₹2.36L ITC**: 9 invoices missing in 2B (vendor hasn't filed), 5 amount differences, 3 GSTIN typos in Tally. The sheet has a vendor-wise follow-up list." },
          { type: "suggestions", items: ["Draft follow-up emails to the 9 vendors", "Fix the 3 GSTIN typos in Tally", "Do this every month on the 14th"] },
        ],
      },
    ],
  },
  { id: "t-diwali", title: "Diwali gifting landing page copy", channel: "web", updatedAt: "yesterday", status: "done", messages: [] },
  { id: "t-rto", title: "Why is RTO high in Tamil Nadu?", channel: "whatsapp", channelLabel: "WhatsApp", updatedAt: "yesterday", status: "done", messages: [] },
  { id: "t-hiring", title: "Shortlist for Brand Manager role", channel: "teams", channelLabel: "Teams · HR", updatedAt: "Mon", status: "done", messages: [] },
  { id: "t-comp", title: "Competitor pricing tracker (dashboard)", channel: "web", updatedAt: "Fri", status: "done", messages: [] },
];

export const knowledgeBases: KnowledgeBase[] = [
  { id: "kb-help", name: "Help center & policies", description: "Return, refund, shipping and warranty policies plus 120 help articles.", sources: [ { appId: "web", label: "help.kesarfoods.in", docs: 124, status: "synced", lastSync: "2 h ago" }, { appId: "gdrive", label: "Drive / Policies", docs: 18, status: "synced", lastSync: "2 h ago" } ], docs: 142, chunks: 2310, usedBy: ["Customer Support", "COD Order Confirmation"], updatedAt: "2 h ago" },
  { id: "kb-catalog", name: "Product catalog", description: "Every SKU with ingredients, allergens, shelf life and pricing.", sources: [ { appId: "shopify", label: "Shopify products", docs: 386, status: "syncing", lastSync: "syncing…" } ], docs: 386, chunks: 1544, usedBy: ["Customer Support", "Anvita (all)"], updatedAt: "syncing" },
  { id: "kb-handbook", name: "Employee handbook", description: "HR policies, leave, reimbursements and IT guidelines.", sources: [ { appId: "notion", label: "Notion / People", docs: 64, status: "synced", lastSync: "yesterday" } ], docs: 64, chunks: 910, usedBy: ["Employee Onboarding", "IT Helpdesk (Voice)"], updatedAt: "yesterday" },
  { id: "kb-finance", name: "Finance SOPs", description: "AP/AR processes, GST rules, vendor master and approval matrix.", sources: [ { appId: "gdrive", label: "Drive / Finance SOPs", docs: 31, status: "error", lastSync: "failed 3 h ago" } ], docs: 31, chunks: 402, usedBy: ["Invoice Processing"], updatedAt: "3 h ago" },
];

export const memories: MemoryItem[] = [
  { id: "mem1", scope: "workspace", type: "glossary", content: "“GMV” at Kesar Foods means gross order value before returns, including GST.", source: "Thread · Monthly MIS", learnedAt: "Oct 03", uses: 41 },
  { id: "mem2", scope: "workspace", type: "fact", content: "Fiscal year runs April–March; Q3 is Oct–Dec (Diwali + wedding season peak).", source: "Onboarding scan · #finance", learnedAt: "Sep 02", uses: 77 },
  { id: "mem3", scope: "user", type: "preference", content: "Priya prefers reports as PDF with a 3-bullet summary on top; numbers in lakhs/crores.", source: "Feedback 👍 on report", learnedAt: "Oct 14", uses: 23 },
  { id: "mem4", scope: "workspace", type: "process", content: "Refunds above ₹5,000 must be approved by the support lead (Rahul).", source: "Policy · Support SOP.pdf", learnedAt: "Sep 07", uses: 132 },
  { id: "mem5", scope: "workspace", type: "person", content: "Kabir Mehta owns vendor payments and Tally; Aman Gupta owns B2B/corporate gifting deals.", source: "Onboarding scan · Slack", learnedAt: "Sep 02", uses: 58 },
  { id: "mem6", scope: "workspace", type: "fact", content: "Primary warehouses: Bhiwandi (west) and Hoskote (south). Delhivery is the default courier.", source: "Thread · RTO analysis", learnedAt: "Oct 21", uses: 9 },
  { id: "mem7", scope: "user", type: "preference", content: "Rahul wants support escalations as Slack DMs, not channel posts.", source: "Correction in #support", learnedAt: "Oct 18", uses: 14 },
];

export const skills: Skill[] = [
  { id: "sk1", name: "Weekly marketing ROAS analysis", description: "Join ad spend with CRM deals by UTM, compute ROAS/CAC, chart and summarize.", author: "anvita", uses: 6, tools: ["metaads", "googleads", "hubspot", "sandbox"] },
  { id: "sk2", name: "GSTR-2B reconciliation", description: "Match purchase register vs GSTR-2B by GSTIN + invoice number; classify mismatches.", author: "pack", pack: "India Finance Pack", uses: 3, tools: ["tally", "gdrive", "sandbox"] },
  { id: "sk3", name: "Brand-voice copywriting", description: "Warm, festive, bilingual (EN + HI) tone with Kesar Foods' do/don't list.", author: "user", uses: 19, tools: [] },
  { id: "sk4", name: "RTO root-cause analysis", description: "Pincode-level RTO by courier, payment mode and time-to-ship.", author: "anvita", uses: 2, tools: ["shopify", "delhivery", "sandbox"] },
  { id: "sk5", name: "E-invoice & e-way bill checks", description: "Validate IRN, e-way bill thresholds and HSN codes.", author: "pack", pack: "India Finance Pack", uses: 11, tools: ["tally"] },
];

export const policies: Policy[] = [
  { id: "p1", name: "External email needs owner approval", appliesTo: "email.send · gmail, outlook", condition: "any recipient outside @kesarfoods.in", effect: "approve", approvers: "Owner", enabled: true, hits30d: 42 },
  { id: "p2", name: "Refunds above ₹5,000", appliesTo: "razorpay.refunds.create", condition: "amount > 5000", effect: "approve", approvers: "Support lead", enabled: true, hits30d: 31 },
  { id: "p3", name: "Never delete records", appliesTo: "*.delete", condition: "always", effect: "deny", enabled: true, hits30d: 3 },
  { id: "p4", name: "CRM writes by Workers", appliesTo: "hubspot.*.update · salesforce.*.update", condition: "actor is a Worker", effect: "approve", approvers: "Record owner", enabled: true, hits30d: 64 },
  { id: "p5", name: "Bulk WhatsApp sends", appliesTo: "whatsapp.templates.send_bulk", condition: "recipients > 500", effect: "approve", approvers: "Owner", enabled: true, hits30d: 2 },
  { id: "p6", name: "Read-only analytics", appliesTo: "*.read · *.search · *.list", condition: "always", effect: "allow", enabled: true, hits30d: 18240 },
  { id: "p7", name: "Payments above ₹1 lakh", appliesTo: "razorpay.payouts.create", condition: "amount > 100000", effect: "approve", approvers: "Finance + Owner (2 of 2)", enabled: false, hits30d: 0 },
];

export const auditEvents: AuditEvent[] = [
  { id: "a1", time: "10:42:13", actor: "Customer Support", actorType: "worker", action: "whatsapp.messages.send", target: "Conversation +91 99••• 4410", channel: "WhatsApp" },
  { id: "a2", time: "10:40:02", actor: "Anvita", actorType: "agent", action: "approval.requested", target: "gmail.send → investors@saffronvc.in", channel: "Slack #growth" },
  { id: "a3", time: "10:38:20", actor: "Invoice Processing", actorType: "worker", action: "approval.requested", target: "tally.vouchers.create SPP/24-25/0912", channel: "Queue" },
  { id: "a4", time: "10:31:47", actor: "Priya Sharma", actorType: "user", action: "connection.created", target: "Google Ads (user scope)", channel: "Slack", ip: "49.36.••.12" },
  { id: "a5", time: "10:20:58", actor: "IT Helpdesk (Voice)", actorType: "worker", action: "okta.users.reset_password", target: "farhan@kesarfoods.in", channel: "Voice" },
  { id: "a6", time: "09:58:01", actor: "Anita Rao", actorType: "user", action: "policy.updated", target: "Refunds above ₹5,000", channel: "Web", ip: "106.51.••.3" },
  { id: "a7", time: "09:45:30", actor: "Rahul Verma", actorType: "user", action: "worker.published", target: "Customer Support v7 (canary 10% → 100%)", channel: "Web", ip: "49.207.••.88" },
  { id: "a8", time: "09:12:44", actor: "System", actorType: "system", action: "kb.sync.failed", target: "Finance SOPs · Drive permission revoked", channel: "—" },
  { id: "a9", time: "08:59:10", actor: "Priya Sharma", actorType: "user", action: "approval.rejected", target: "whatsapp.templates.send_bulk (1,240)", channel: "Mobile" },
  { id: "a10", time: "08:30:00", actor: "System", actorType: "system", action: "budget.alert", target: "Workspace at 64% of monthly credits", channel: "Email" },
];

export const inbox: InboxConversation[] = [
  {
    id: "c1",
    customer: "Meera Krishnan",
    phone: "+91 98410 •• 221",
    channel: "whatsapp",
    worker: "Customer Support",
    reason: "Refund > ₹5,000 · customer upset",
    sentiment: "negative",
    language: "English",
    waiting: "3 min",
    summary: "Order #KF-20931 (Kaju Katli gift box ×3, ₹6,499) arrived crushed. Photos verified. Eligible for refund within 7 days. Customer wants refund, not replacement, before Diwali. Refund awaiting approval.",
    transcript: [
      { from: "customer", text: "My Diwali gift boxes arrived completely crushed!! This is so disappointing 😡", time: "10:29" },
      { from: "worker", text: "I'm really sorry, Meera. That's not the experience we want for your Diwali gifts. Could you share a photo of the boxes and your order number?", time: "10:29" },
      { from: "customer", text: "#KF-20931. [3 photos]", time: "10:31" },
      { from: "worker", text: "Thank you. I can see the damage clearly and your order is within our 7-day return window. Would you prefer a refund or a replacement delivered before 1 Nov?", time: "10:31" },
      { from: "customer", text: "Refund. I don't trust it'll come in time.", time: "10:32" },
      { from: "worker", text: "Understood. I've requested a full refund of ₹6,499 to your original payment method — a teammate will confirm in a few minutes.", time: "10:32" },
    ],
  },
  {
    id: "c2",
    customer: "Arjun Patel",
    phone: "+91 99099 •• 815",
    channel: "voice",
    worker: "IT Helpdesk (Voice)",
    reason: "Couldn't verify identity",
    sentiment: "neutral",
    language: "Hindi",
    waiting: "8 min",
    summary: "Employee says he lost his phone; cannot receive OTP to verify. Requests MFA reset in Okta. Needs manual identity verification by IT.",
    transcript: [
      { from: "customer", text: "Namaste, mera phone kho gaya hai, Okta login nahi ho raha.", time: "10:21" },
      { from: "worker", text: "Samajh gaya, Arjun ji. Verification ke liye main aapke registered Slack par OTP bhej raha hoon.", time: "10:21" },
      { from: "customer", text: "Slack bhi phone par hi tha…", time: "10:22" },
      { from: "worker", text: "Koi baat nahi. Main aapko IT team se connect kar raha hoon — unhe poori jaankari mil chuki hai.", time: "10:22" },
    ],
  },
  {
    id: "c3",
    customer: "Sana Q.",
    phone: "visitor-18c2",
    channel: "widget",
    worker: "Customer Support",
    reason: "Bulk corporate order (>200 boxes)",
    sentiment: "positive",
    language: "English",
    waiting: "15 min",
    summary: "Wants 250 custom-branded Diwali hampers for her company by 5 Nov, budget ~₹3L. Sales lead — route to Aman (corporate gifting).",
    transcript: [
      { from: "customer", text: "Hi! Do you do custom branded hampers for corporates? Need ~250.", time: "10:10" },
      { from: "worker", text: "Yes, we do! Our corporate gifting team can customise boxes with your logo. I'll connect you with Aman who handles corporate orders.", time: "10:11" },
    ],
  },
];

export const usageDaily = Array.from({ length: 30 }, (_, i) => {
  const base = 3200 + Math.round(Math.sin(i / 3) * 600) + i * 70;
  return {
    day: i < 3 ? `${28 + i} Sep` : `${i - 2} Oct`,
    agent: Math.round(base * 0.35),
    workers: Math.round(base * 0.55),
    voice: Math.round(base * 0.1),
    runs: 600 + Math.round(Math.cos(i / 4) * 90) + i * 12,
    automated: 78 + Math.round(Math.sin(i / 5) * 4 + i * 0.15),
  };
});
