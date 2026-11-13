import { and, eq, sql } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { appById } from "../catalog/index.js";
import { parseCredentials } from "../connectors/index.js";
import { makeCaller } from "../connectors/http.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { approvals, connections, memberships, users, workspaces, type ApprovalAlert, type Role } from "../db/schema.js";
import { assertFound, conflict, forbidden } from "../lib/errors.js";
import { enqueue } from "../jobs/queue.js";
import { toolByName } from "../runtime/tools/index.js";
import { audit } from "./audit.js";
import { sendEmail } from "./email.js";
import { publish } from "./events.js";
import { roleAtLeast } from "./rbac.js";
import { serializeApproval } from "./serializers.js";
import { emitWebhook } from "./webhooks.js";

/**
 * Approval requests leave the app: every eligible approver is alerted on the channel they chose
 * in their profile (email with one-click links, a Slack DM with Approve / Reject buttons, or a
 * WhatsApp message with reply buttons), falling back to email when that channel isn't set up.
 * A workspace can also post every request to one Slack channel. Decisions taken anywhere go
 * through `decideApproval`, and the Slack cards are updated to show the outcome.
 */

export type Approval = typeof approvals.$inferSelect;
export type Decision = "approved" | "rejected";
export interface Decider { userId: string | null; name: string; role: Role }

// ─── Deciding ─────────────────────────────────────────────────────────────────

export async function decideApproval(workspaceId: string, id: string, by: Decider, decision: Decision, opts: { payload?: Record<string, unknown>; note?: string; ip?: string; via?: "web" | "email" | "slack" | "whatsapp" | "api" } = {}) {
  const row = assertFound((await db.select().from(approvals).where(and(eq(approvals.id, id), eq(approvals.workspaceId, workspaceId))))[0], "Approval");
  if (row.approverRole && !roleAtLeast(by.role, row.approverRole)) throw forbidden(`This approval needs a ${row.approverRole} or above`);
  if (row.status !== "pending") throw conflict(`Already ${row.status}${row.decidedBy ? ` by ${row.decidedBy}` : ""}`);

  const patch: Partial<typeof approvals.$inferInsert> = { status: decision, decidedBy: by.name, decidedAt: new Date() };
  if (decision === "approved" && opts.payload) {
    const tool = [...toolByName.values()].find((t) => t.action === row.action);
    patch.payload = { ...row.payload, ...opts.payload };
    const re = tool?.approval?.(patch.payload as never, { workspaceId, runId: row.runId ?? "", threadId: row.threadId, actor: row.requestedBy, onBehalfOf: { userId: null, name: row.onBehalfOf }, workspaceDomains: [], connection: null });
    if (re) patch.preview = re.preview;
  }
  // Conditional update guards against two approvers racing (e.g. web and Slack at once).
  const [updated] = await db.update(approvals).set(patch).where(and(eq(approvals.id, row.id), eq(approvals.status, "pending"))).returning();
  if (!updated) throw conflict("This approval was just decided by someone else");

  await publish({ workspaceId, threadId: updated.threadId, runId: updated.runId, type: "approval.updated", data: serializeApproval(updated) });
  await audit({ workspaceId, actor: by.name, actorId: by.userId, action: `approval.${decision}`, target: `${row.action} · ${row.title}`, ip: opts.ip, channel: opts.via && opts.via !== "web" ? opts.via[0].toUpperCase() + opts.via.slice(1) : undefined, payload: { approvalId: row.id, edited: !!opts.payload, note: opts.note } });
  await emitWebhook(workspaceId, "approval.decided", serializeApproval(updated));
  if (updated.runId) await enqueue("run.advance", { runId: updated.runId }, { maxAttempts: 3 });
  if (updated.alerts.some((a) => a.kind === "slack")) await enqueue("approval.alerts.update", { approvalId: updated.id }, { maxAttempts: 3 });
  return updated;
}

// ─── One-click links (email) ──────────────────────────────────────────────────

const secret = new TextEncoder().encode(`${config.JWT_SECRET}:approval-links`);

export async function decisionToken(a: Approval, userId: string, decision: Decision) {
  return new SignJWT({ typ: "approval", apr: a.id, ws: a.workspaceId, d: decision })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(a.expiresAt.getTime() / 1000))
    .sign(secret);
}

export async function readDecisionToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.typ !== "approval" || !payload.sub) return null;
    return { approvalId: String(payload.apr), workspaceId: String(payload.ws), userId: payload.sub, decision: payload.d as Decision };
  } catch {
    return null;
  }
}

/** The member behind a link / Slack user / phone number, with their current role. */
export async function deciderFor(workspaceId: string, match: { userId?: string; email?: string; phone?: string }): Promise<Decider | null> {
  const cond = match.userId ? eq(memberships.userId, match.userId) : match.email ? sql`lower(${memberships.email}) = ${match.email.toLowerCase()}` : match.phone ? eq(users.phone, match.phone.replace(/\D/g, "")) : null;
  if (!cond) return null;
  const [m] = await db.select({ userId: memberships.userId, name: memberships.name, role: memberships.role }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, "active"), cond));
  return m ? { userId: m.userId, name: m.name, role: m.role } : null;
}

// ─── Fan-out ──────────────────────────────────────────────────────────────────

async function liveConnection(workspaceId: string, appId: string) {
  const [c] = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.appId, appId), eq(connections.mode, "live"), eq(connections.status, "healthy")));
  const credentials = c ? parseCredentials(c.credentialsEnc) : null;
  return c && credentials ? { id: c.id, credentials } : null;
}

const reviewUrl = (a: Approval) => `${config.WEB_URL}/approvals?id=${a.id}`;
const summary = (a: Approval) => `${a.requestedBy.name} wants to ${a.title.charAt(0).toLowerCase()}${a.title.slice(1)}`;

function previewLines(a: Approval): string[] {
  const p = a.preview as { kind?: string; to?: string; subject?: string; changes?: { field: string; to: string }[]; amount?: number; record?: string };
  const lines: string[] = [];
  if (p.to) lines.push(`To: ${p.to}`);
  if (p.subject) lines.push(`Subject: ${p.subject}`);
  for (const c of (p.changes ?? []).slice(0, 6)) lines.push(`${c.field}: ${String(c.to).slice(0, 140)}`);
  return lines;
}

function slackBlocks(a: Approval, decided?: { status: string; by: string | null }) {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${decided ? "Approval" : "Approval needed"}: ${a.title}*\n${a.reason}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${a.requestedBy.name} · on behalf of ${a.onBehalfOf} · ${appById[a.appId]?.name ?? a.appId} · risk ${a.risk}` }] },
  ];
  const lines = previewLines(a);
  if (lines.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: lines.map((l) => `• ${l}`).join("\n").slice(0, 2900) } });
  if (decided) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${decided.status === "approved" ? "✅ Approved" : decided.status === "rejected" ? "❌ Rejected" : "⌛ Expired"}${decided.by ? ` by ${decided.by}` : ""}` }] });
  else
    blocks.push({
      type: "actions",
      block_id: `apr:${a.id}`,
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approval.approve", value: a.id },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: "approval.reject", value: a.id, confirm: { title: { type: "plain_text", text: "Reject this action?" }, text: { type: "plain_text", text: "The Worker will be told it was rejected." }, confirm: { type: "plain_text", text: "Reject" }, deny: { type: "plain_text", text: "Cancel" } } },
        { type: "button", text: { type: "plain_text", text: "Review / edit" }, url: reviewUrl(a), action_id: "approval.open" },
      ],
    });
  return blocks;
}

async function postSlack(conn: NonNullable<Awaited<ReturnType<typeof liveConnection>>>, channel: string, a: Approval) {
  const call = makeCaller("slack", conn.id, conn.credentials);
  const r = await call<{ ok: boolean; error?: string; channel: string; ts: string }>("https://slack.com/api/chat.postMessage", { body: { channel, text: `Approval needed: ${a.title}`, blocks: slackBlocks(a), unfurl_links: false } });
  if (!r.ok) throw new Error(`Slack: ${r.error}`);
  return { kind: "slack" as const, channel: r.channel, ts: r.ts };
}

async function slackUserId(conn: NonNullable<Awaited<ReturnType<typeof liveConnection>>>, email: string) {
  const call = makeCaller("slack", conn.id, conn.credentials);
  const r = await call<{ ok: boolean; user?: { id: string } }>(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`).catch(() => null);
  return r?.ok ? r.user?.id ?? null : null;
}

async function sendWhatsAppApproval(conn: NonNullable<Awaited<ReturnType<typeof liveConnection>>>, to: string, a: Approval, template: string | null) {
  const call = makeCaller("whatsapp", conn.id, conn.credentials);
  const url = "https://graph.facebook.com/v21.0/{phone_number_id}/messages";
  if (template) {
    // Outside the 24-hour window WhatsApp only delivers approved templates. The template needs two
    // body variables ({{1}} what, {{2}} who) and two quick-reply buttons (Approve, Reject).
    await call(url, {
      body: {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template,
          language: { code: "en" },
          components: [
            { type: "body", parameters: [{ type: "text", text: a.title.slice(0, 200) }, { type: "text", text: a.requestedBy.name }] },
            { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `apr:${a.id}:approved` }] },
            { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `apr:${a.id}:rejected` }] },
          ],
        },
      },
    });
    return;
  }
  await call(url, {
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: [`*Approval needed:* ${a.title}`, a.reason, ...previewLines(a)].join("\n").slice(0, 1000) },
        footer: { text: `${a.requestedBy.name} · Anvita` },
        action: { buttons: [{ type: "reply", reply: { id: `apr:${a.id}:approved`, title: "Approve" } }, { type: "reply", reply: { id: `apr:${a.id}:rejected`, title: "Reject" } }] },
      },
    },
  });
}

async function emailApproval(a: Approval, to: { userId: string; email: string; name: string }) {
  const link = async (d: Decision) => `${config.PUBLIC_URL}/v1/approvals/respond?t=${await decisionToken(a, to.userId, d)}`;
  const [approve, reject] = await Promise.all([link("approved"), link("rejected")]);
  const lines = previewLines(a);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  await sendEmail({
    to: to.email,
    subject: `Approval needed: ${a.title}`,
    text: `${summary(a)}.\n\n${a.reason}\n${lines.join("\n")}\n\nApprove: ${approve}\nReject: ${reject}\nReview or edit first: ${reviewUrl(a)}\n\nThis request expires ${a.expiresAt.toUTCString()}.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="font-size:18px">${esc(a.title)}</h2><p>${esc(summary(a))}.</p><p style="color:#555">${esc(a.reason)}</p>${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}<p><a href="${approve}" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-right:8px">Approve</a><a href="${reject}" style="background:#dc2626;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-right:8px">Reject</a><a href="${reviewUrl(a)}">Review or edit</a></p><p style="color:#888;font-size:12px">Expires ${esc(a.expiresAt.toUTCString())}. The links work once and only for you.</p></div>`,
  });
}

/** Job: alert every eligible approver. Each channel failing falls back to email. */
export async function alertApprovers(approvalId: string) {
  const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!a || a.status !== "pending") return;
  const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, a.workspaceId));
  const settings = ws?.settings ?? {};
  const people = (
    await db
      .select({ userId: users.id, email: users.email, name: users.name, channel: users.approvalChannel, phone: users.phone, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, a.workspaceId), eq(memberships.status, "active")))
  ).filter((p) => roleAtLeast(p.role, a.approverRole ?? "member"));

  const slack = await liveConnection(a.workspaceId, "slack");
  const whatsapp = await liveConnection(a.workspaceId, "whatsapp");
  const alerts: ApprovalAlert[] = [];
  const failures: string[] = [];

  const channel = String(settings["notify.approvalsSlackChannel"] ?? "").trim();
  if (slack && channel) await postSlack(slack, channel, a).then((r) => alerts.push(r), (e) => failures.push(`slack ${channel}: ${(e as Error).message}`));

  for (const p of people) {
    try {
      if (p.channel === "slack" && slack) {
        const uid = await slackUserId(slack, p.email);
        if (uid) {
          alerts.push(await postSlack(slack, uid, a));
          continue;
        }
      }
      if (p.channel === "whatsapp" && whatsapp && p.phone) {
        await sendWhatsAppApproval(whatsapp, p.phone, a, String(settings["notify.whatsappTemplate"] ?? "") || null);
        alerts.push({ kind: "whatsapp", to: p.phone });
        continue;
      }
      await emailApproval(a, p);
      alerts.push({ kind: "email", to: p.email });
    } catch (e) {
      failures.push(`${p.email}: ${(e as Error).message}`);
      // Last resort: email (unless that's what failed).
      if (p.channel !== "email") await emailApproval(a, p).then(() => alerts.push({ kind: "email", to: p.email }), () => {});
    }
  }
  await db.update(approvals).set({ alerts }).where(eq(approvals.id, a.id));
  if (failures.length) await audit({ workspaceId: a.workspaceId, actor: "Anvita", actorType: "system", action: "approval.alert_failed", target: a.title, payload: { failures: failures.slice(0, 10) } });
}

/** Job: once decided (or expired), replace the buttons on every Slack card with the outcome. */
export async function updateApprovalAlerts(approvalId: string) {
  const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!a || a.status === "pending") return;
  const slack = await liveConnection(a.workspaceId, "slack");
  if (!slack) return;
  const call = makeCaller("slack", slack.id, slack.credentials);
  for (const al of a.alerts) {
    if (al.kind !== "slack") continue;
    await call("https://slack.com/api/chat.update", { body: { channel: al.channel, ts: al.ts, text: `${a.title} — ${a.status}`, blocks: slackBlocks(a, { status: a.status, by: a.decidedBy }) } }).catch(() => {});
  }
}
