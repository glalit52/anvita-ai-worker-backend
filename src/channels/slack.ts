import { and, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { hmacSha256, safeEqual } from "../lib/crypto.js";
import { makeCaller } from "../connectors/http.js";
import { db } from "../db/client.js";
import { memberships } from "../db/schema.js";
import { startAgentRun } from "../modules/chat.js";
import { connectionByExternalId, ensureThread } from "./common.js";

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
