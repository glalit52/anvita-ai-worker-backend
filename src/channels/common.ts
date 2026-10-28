import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { channelEvents, connections, threads } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { publish } from "../services/events.js";
import { serializeThread } from "../services/serializers.js";
import { parseCredentials } from "../connectors/index.js";

/** True the first time an inbound event id is seen (providers retry deliveries). */
export async function firstDelivery(eventId: string): Promise<boolean> {
  const rows = await db.insert(channelEvents).values({ id: eventId }).onConflictDoNothing().returning({ id: channelEvents.id });
  return rows.length > 0;
}

/** Live connection routed by the provider-side id (Slack team, WhatsApp phone number). */
export async function connectionByExternalId(appId: string, externalId: string) {
  const [c] = await db.select().from(connections).where(and(eq(connections.appId, appId), eq(connections.externalId, externalId), eq(connections.mode, "live")));
  if (!c) return null;
  const credentials = parseCredentials(c.credentialsEnc);
  return credentials ? { ...c, credentials } : null;
}

export async function ensureThread(workspaceId: string, ref: string, init: { title: string; channel: "slack" | "whatsapp" | "teams"; channelLabel: string; workerId?: string | null }) {
  const [existing] = await db.select().from(threads).where(and(eq(threads.workspaceId, workspaceId), eq(threads.externalRef, ref)));
  if (existing) return existing;
  const [t] = await db
    .insert(threads)
    .values({ id: newId("thr"), workspaceId, title: init.title.length > 60 ? `${init.title.slice(0, 58)}…` : init.title, channel: init.channel, channelLabel: init.channelLabel, workerId: init.workerId ?? null, externalRef: ref, unread: true })
    .onConflictDoNothing()
    .returning();
  if (!t) return (await db.select().from(threads).where(and(eq(threads.workspaceId, workspaceId), eq(threads.externalRef, ref))))[0];
  await publish({ workspaceId, threadId: t.id, type: "thread.created", data: serializeThread(t) });
  return t;
}

/** Markdown → Slack mrkdwn. */
export function toSlack(md: string) {
  return md
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

/** Markdown → WhatsApp formatting. */
export function toWhatsApp(md: string) {
  return md
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}
