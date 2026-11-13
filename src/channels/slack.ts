import { and, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { hmacSha256, safeEqual } from "../lib/crypto.js";
import { makeCaller } from "../connectors/http.js";
import { db } from "../db/client.js";
import { memberships } from "../db/schema.js";
import { startAgentRun } from "../modules/chat.js";
import { connectionByExternalId, ensureThread } from "./common.js";
import { decideApproval, deciderFor } from "../services/approval-alerts.js";

/** Slack request signing: v0=hex(hmac_sha256(secret, "v0:<ts>:<raw body>")), rejecting replays older than 5 minutes. */
export function verifySlackSignature(rawBody: string, ts: string | undefined, sig: string | undefined, secret: string | undefined): boolean {
  if (!secret || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  return safeEqual(sig, `v0=${hmacSha256(secret, `v0:${ts}:${rawBody}`)}`);
}

export interface SlackEventEnvelope {
  team_id: string;
  event_id: string;
  event: { type: string; channel: string; channel_type?: string; user?: string; text?: string; ts: string; thread_ts?: string; bot_id?: string; subtype?: string };
}

/** Turn an @mention or DM into an Anvita run in the matching thread. */
export async function handleSlackEvent(env: SlackEventEnvelope, log: FastifyBaseLogger) {
  const ev = env.event;
  if (ev.bot_id || ev.subtype || !ev.user || !ev.text) return;
  if (ev.type !== "app_mention" && !(ev.type === "message" && ev.channel_type === "im")) return;
  const conn = await connectionByExternalId("slack", env.team_id);
  if (!conn) return log.warn({ team: env.team_id }, "slack event for unknown team");
  const call = makeCaller("slack", conn.id, conn.credentials);
  const text = ev.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return;

  // Map the Slack user to a workspace member by email when possible.
  let name = "Slack user";
  let userId: string | null = null;
  try {
    const u = await call<{ ok: boolean; user?: { real_name?: string; profile?: { email?: string; real_name?: string } } }>(`https://slack.com/api/users.info?user=${encodeURIComponent(ev.user)}`);
    name = u.user?.real_name || u.user?.profile?.real_name || name;
    const email = u.user?.profile?.email?.toLowerCase();
    if (email) {
      const [m] = await db.select().from(memberships).where(and(eq(memberships.workspaceId, conn.workspaceId), sql`lower(${memberships.email}) = ${email}`, eq(memberships.status, "active")));
      if (m) {
        userId = m.userId;
        name = m.name;
      }
    }
  } catch (err) {
    log.warn({ err }, "slack users.info failed");
  }

  const root = ev.thread_ts ?? ev.ts;
  const thread = await ensureThread(conn.workspaceId, `slack:${ev.channel}:${root}`, { title: text, channel: "slack", channelLabel: ev.channel_type === "im" ? "Slack DM" : "Slack" });
  await startAgentRun({ userId, userName: name, email: null, workspaceId: conn.workspaceId, role: "member" }, thread.id, { text }, { trigger: "Slack" });
}

export async function postToSlack(conn: NonNullable<Awaited<ReturnType<typeof connectionByExternalId>>>, ref: string, text: string) {
  const [, channel, threadTs] = ref.split(":");
  const call = makeCaller("slack", conn.id, conn.credentials);
  const r = await call<{ ok: boolean; error?: string }>("https://slack.com/api/chat.postMessage", { body: { channel, thread_ts: threadTs, text: text.slice(0, 39_000), unfurl_links: false } });
  if (!r.ok) throw new Error(`Slack: ${r.error}`);
}

export interface SlackInteraction {
  type: string;
  team?: { id: string };
  user?: { id: string; name?: string };
  actions?: { action_id: string; value?: string }[];
  response_url?: string;
}

async function respond(url: string | undefined, text: string) {
  if (!url || !/^https:\/\/hooks\.slack\.com\//.test(url)) return;
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }), signal: AbortSignal.timeout(5000) }).catch(() => {});
}

/** Approve / Reject pressed on an approval card: map the Slack user to a member by email and decide. */
export async function handleSlackInteraction(p: SlackInteraction) {
  if (p.type !== "block_actions" || !p.team?.id || !p.user?.id) return;
  const action = p.actions?.find((a) => a.action_id === "approval.approve" || a.action_id === "approval.reject");
  if (!action?.value) return;
  const conn = await connectionByExternalId("slack", p.team.id);
  if (!conn) return respond(p.response_url, "This Slack workspace isn't connected to Anvita any more.");
  const call = makeCaller("slack", conn.id, conn.credentials);
  const u = await call<{ ok: boolean; user?: { profile?: { email?: string } } }>(`https://slack.com/api/users.info?user=${encodeURIComponent(p.user.id)}`).catch(() => null);
  const email = u?.user?.profile?.email;
  const who = email ? await deciderFor(conn.workspaceId, { email }) : null;
  if (!who) return respond(p.response_url, "I couldn't match your Slack account to an Anvita member (the email addresses must match).");
  try {
    const row = await decideApproval(conn.workspaceId, action.value, who, action.action_id === "approval.approve" ? "approved" : "rejected", { via: "slack" });
    await respond(p.response_url, `${row.status === "approved" ? "✅ Approved" : "❌ Rejected"}: ${row.title}`);
  } catch (e) {
    await respond(p.response_url, (e as Error).message);
  }
}
