/**
 * Seeds a demo workspace ("Kesar Foods") from the web app's mock dataset, so the frontend shows
 * the same content when pointed at the API. Idempotent: does nothing if the demo user exists.
 *
 *   npm run db:seed            # demo login: priya@kesarfoods.in / anvita-demo-2026
 */
import { eq } from "drizzle-orm";
import { hashPassword } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { ingestDocument } from "../services/knowledge.js";
import { charge } from "../services/credits.js";
import { createWorkspace } from "../services/workspace.js";
import { closeDb, db } from "./client.js";
import { runMigrations } from "./migrate.js";
import * as S from "./schema.js";
import { connections as seedConnections } from "./seed-data/apps.js";
import { seedEvalCases, seedMcpServers, seedNotifications } from "./seed-data/extra.js";
import { queueItems as seedQueue, workers as seedWorkers } from "./seed-data/workers.js";
import { approvals as seedApprovals, currentUser, inbox as seedInbox, knowledgeBases as seedKbs, members as seedMembers, memories as seedMemories, skills as seedSkills, threads as seedThreads, workspace as seedWorkspace } from "./seed-data/workspace.js";

export const DEMO_PASSWORD = "anvita-demo-2026";

const KB_TEXT: Record<string, string> = {
  "kb-help": `Returns & refunds policy\n\nYou can request a return within 7 days of delivery for damaged, wrong or expired items. Share a photo of the item and packaging.\n\nRefunds are issued to the original payment method within 5–7 working days. COD orders are refunded by UPI or bank transfer.\n\nRefunds above ₹5,000 are reviewed by the support lead before processing.\n\nShipping\n\nWe ship across India with Delhivery. Metro deliveries take 2–4 days; other locations 4–7 days. Orders above ₹999 ship free.`,
  "kb-catalog": `Kaju Katli 500g — ingredients: cashew, sugar, ghee, silver leaf (vark). Contains tree nuts. Gluten free. Shelf life 15 days.\n\nSoan Papdi 250g — ingredients: gram flour, wheat flour, sugar, ghee, cardamom. Contains gluten. Shelf life 60 days.\n\nDiwali Gift Hamper — assorted sweets and dry fruits in a reusable box. Corporate pricing from 50 units.`,
  "kb-handbook": `Leave policy\n\nEmployees get 18 days of paid leave and 10 public holidays per year. Apply in Darwinbox at least 3 days in advance.\n\nReimbursements\n\nSubmit travel and food bills within 30 days with receipts. Approval by your manager; payout with the next salary cycle.`,
  "kb-finance": `Accounts payable SOP\n\nEvery purchase invoice must be matched to a PO and GRN (3-way match) before posting in Tally. Vendor GSTIN must match the vendor master.\n\nPayments above ₹1,00,000 need Finance and Owner approval.`,
};

async function main() {
  await runMigrations();
  const [existing] = await db.select().from(S.users).where(eq(S.users.email, currentUser.email));
  if (existing) {
    console.log(`Demo user ${currentUser.email} already exists — skipping seed.`);
    return;
  }

  const ownerId = newId("usr");
  await db.insert(S.users).values({ id: ownerId, email: currentUser.email, name: currentUser.name, title: "Founder & CEO", passwordHash: await hashPassword(DEMO_PASSWORD), approvalChannel: "slack", quietHours: true });
  const wsId = await db.transaction((tx) => createWorkspace(tx, { name: seedWorkspace.name, owner: { userId: ownerId, name: currentUser.name, email: currentUser.email }, domains: ["kesarfoods.in"] }));
  await db.update(S.workspaces).set({ installedPacks: ["India Finance Pack (GST, TDS, e-invoice)"] }).where(eq(S.workspaces.id, wsId));

  // Members (teammates get accounts with the same demo password so you can try roles)
  const userIds: Record<string, string> = { [currentUser.email]: ownerId };
  for (const m of seedMembers.filter((x) => x.email !== currentUser.email)) {
    let userId: string | null = null;
    if (m.status === "active") {
      userId = newId("usr");
      userIds[m.email] = userId;
      await db.insert(S.users).values({ id: userId, email: m.email, name: m.name, passwordHash: await hashPassword(DEMO_PASSWORD) });
    }
    await db.insert(S.memberships).values({ id: newId("mem"), workspaceId: wsId, userId, email: m.email, name: m.name, role: m.role, status: m.status, sso: !!m.sso, lastActiveAt: m.status === "active" ? new Date() : null });
  }

  // Connections (demo driver — no credentials)
  for (const c of seedConnections.filter((x) => !["web", "sandbox"].includes(x.appId))) {
    await db.insert(S.connections).values({ id: newId("con"), workspaceId: wsId, appId: c.appId, scope: c.scope, connectedByName: c.connectedBy, status: c.status, sharedWith: c.sharedWith ?? [], actionsUsed30d: c.actionsUsed30d });
  }
  for (const m of seedMcpServers) await db.insert(S.mcpServers).values({ id: newId("mcp"), workspaceId: wsId, name: m.name, url: m.url, auth: m.auth, tools: m.tools, status: m.status });

  // Workers (published) + queue + evals
  const workerIds: Record<string, string> = {};
  for (const w of seedWorkers) {
    const id = newId("wrk");
    workerIds[w.id] = id;
    const cron = w.nodes.find((n) => n.kind === "trigger")?.config?.cron;
    await db.insert(S.workers).values({
      id,
      workspaceId: wsId,
      name: w.name,
      description: w.description,
      emoji: w.emoji,
      color: w.color,
      interaction: w.interaction,
      channels: w.channels,
      status: w.status,
      version: w.version,
      ownerName: w.owner,
      ownerId: userIds[seedMembers.find((m) => m.name === w.owner)?.email ?? ""] ?? null,
      apps: w.apps,
      trigger: w.trigger,
      // Demo schedules are stored but not auto-fired (avoid surprise runs/credits); enable by editing the worker.
      schedule: null,
      createdFrom: w.createdFrom ?? "template",
      pinned: !!w.pinned,
      nodes: w.nodes,
      edges: w.edges,
      webhookSecret: `whsec_${newId("x").slice(2)}`,
    });
    if (w.version > 0) await db.insert(S.workerVersions).values({ id: newId("wv"), workerId: id, workspaceId: wsId, version: w.version, snapshot: { name: w.name, nodes: w.nodes, edges: w.edges, apps: w.apps, cron: cron ?? null }, publishedBy: w.owner, note: "Imported" });
  }
  const invoiceWorker = workerIds["invoices"] ?? Object.values(workerIds)[0];
  for (const q of seedQueue) await db.insert(S.queueItems).values({ id: newId("qi"), workspaceId: wsId, workerId: invoiceWorker, ref: q.ref, title: q.title, source: q.source, status: q.status, confidence: q.confidence, amount: q.amount ?? null, assignee: q.assignee ?? null, fields: q.fields });
  if (workerIds["support"]) for (const e of seedEvalCases) await db.insert(S.evalCases).values({ id: newId("evc"), workerId: workerIds["support"], workspaceId: wsId, input: e.input, expected: e.expected, category: e.category, score: e.score, pass: e.pass, ms: e.ms, lastRunAt: new Date() });

  // Knowledge
  for (const kb of seedKbs) {
    const id = newId("kb");
    await db.insert(S.knowledgeBases).values({ id, workspaceId: wsId, name: kb.name, description: kb.description, usedBy: kb.usedBy });
    for (const s of kb.sources) await db.insert(S.kbSources).values({ id: newId("kbs"), kbId: id, workspaceId: wsId, appId: s.appId, label: s.label, status: s.status, lastSyncAt: s.status === "error" ? null : new Date(), error: s.status === "error" ? s.lastSync : null });
    if (KB_TEXT[kb.id]) await ingestDocument({ workspaceId: wsId, kbId: id, title: `${kb.name} (overview)`, content: KB_TEXT[kb.id] });
  }
  for (const m of seedMemories) await db.insert(S.memories).values({ id: newId("mem"), workspaceId: wsId, scope: m.scope, scopeId: m.scope === "user" ? ownerId : null, type: m.type, content: m.content, source: m.source, uses: m.uses });
  for (const s of seedSkills) await db.insert(S.skills).values({ id: newId("skl"), workspaceId: wsId, name: s.name, description: s.description, author: s.author, pack: s.pack ?? null, uses: s.uses, tools: s.tools });

  // Conversations (history only — no live runs)
  let t0 = Date.now() - 3 * 86400_000;
  for (const t of seedThreads) {
    const id = newId("thr");
    await db.insert(S.threads).values({ id, workspaceId: wsId, createdBy: ownerId, title: t.title, channel: t.channel, channelLabel: t.channelLabel ?? null, pinned: !!t.pinned, unread: !!t.unread, status: "done", createdAt: new Date(t0), updatedAt: new Date(t0) });
    for (const m of t.messages) {
      t0 += 60_000;
      await db.insert(S.messages).values({ id: newId("msg"), workspaceId: wsId, threadId: id, role: m.role, author: m.author, blocks: m.blocks.filter((b) => b.type !== "approval"), createdAt: new Date(t0) });
    }
  }

  // Pending approvals (not attached to a live run, so decisions just record)
  for (const a of seedApprovals.filter((x) => x.status === "pending")) {
    await db.insert(S.approvals).values({ id: newId("apr"), workspaceId: wsId, title: a.title, action: a.action, appId: a.appId, requestedBy: a.requestedBy, onBehalfOf: a.onBehalfOf, reason: a.reason, risk: a.risk, credits: a.credits, preview: a.preview, payload: {}, approverRole: "member", expiresAt: new Date(Date.now() + 20 * 3600_000) });
  }
  for (const c of seedInbox) {
    const mins = Number(/(\d+)/.exec(c.waiting)?.[1] ?? 5);
    await db.insert(S.inboxConversations).values({ id: newId("inb"), workspaceId: wsId, workerName: c.worker, workerId: workerIds["support"] ?? null, customer: c.customer, phone: c.phone, channel: c.channel, reason: c.reason, sentiment: c.sentiment, language: c.language, summary: c.summary, transcript: c.transcript, waitingSince: new Date(Date.now() - mins * 60_000) });
  }
  for (const n of seedNotifications) await db.insert(S.notifications).values({ id: newId("ntf"), workspaceId: wsId, userId: ownerId, appId: n.appId, title: n.title, meta: n.meta, href: n.href, read: n.read });

  // Month-to-date usage so billing matches the demo
  await charge(wsId, seedWorkspace.creditsUsed, { type: "seed", id: wsId }, { note: "Imported month-to-date usage" });

  console.log(`Seeded workspace "${seedWorkspace.name}" (${wsId}).\nLogin: ${currentUser.email} / ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closeDb);
