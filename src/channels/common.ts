import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { channelEvents, connections, inboxConversations, messages, threads } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { publish } from "../services/events.js";
import { serializeInbox, serializeMessage, serializeThread } from "../services/serializers.js";
import { startAgentRun } from "../modules/chat.js";
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

export type ThreadChannel = "slack" | "whatsapp" | "teams" | "widget" | "email" | "voice";

export async function ensureThread(workspaceId: string, ref: string, init: { title: string; channel: ThreadChannel; channelLabel: string; workerId?: string | null }) {
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

/**
 * One inbound customer message on any channel: find or open the conversation's thread; if a
 * teammate has taken it over in the Inbox, record the message for them; otherwise run the
 * channel's Worker (customer mode). Returns the thread and the run, if one started.
 */
export async function routeInbound(o: { workspaceId: string; ref: string; channel: ThreadChannel; channelLabel: string; title: string; workerId?: string | null; author: string; text: string; trigger: string; customer?: boolean }) {
  const thread = await ensureThread(o.workspaceId, o.ref, { title: o.title, channel: o.channel, channelLabel: o.channelLabel, workerId: o.workerId });
  const [handoff] = await db.select().from(inboxConversations).where(and(eq(inboxConversations.threadId, thread.id), eq(inboxConversations.status, "taken")));
  if (handoff) {
    const [c] = await db.update(inboxConversations).set({ transcript: [...handoff.transcript, { from: "customer", text: o.text, time: new Date().toISOString() }], updatedAt: new Date() }).where(eq(inboxConversations.id, handoff.id)).returning();
    await publish({ workspaceId: o.workspaceId, type: "inbox.updated", data: serializeInbox(c) });
    const [msg] = await db.insert(messages).values({ id: newId("msg"), workspaceId: o.workspaceId, threadId: thread.id, role: "user", author: o.author, blocks: [{ type: "text", text: o.text }] }).returning();
    await publish({ workspaceId: o.workspaceId, threadId: thread.id, type: "message.created", data: serializeMessage(msg) });
    return { thread, run: null, handedOff: true };
  }
  const started = await startAgentRun({ userId: null, userName: o.author, email: null, workspaceId: o.workspaceId, role: "member" }, thread.id, { text: o.text }, { workerId: o.workerId ?? null, trigger: o.trigger, customer: o.customer ?? true });
  return { thread, run: (started as { run?: { id: string } }).run ?? null, handedOff: false };
}

/** Post a teammate's (or system) reply into a thread so polling channels (widget, voice) see it. */
export async function postAssistantText(workspaceId: string, threadId: string, author: string, text: string) {
  const [msg] = await db.insert(messages).values({ id: newId("msg"), workspaceId, threadId, role: "assistant", author, blocks: [{ type: "text", text }] }).returning();
  await publish({ workspaceId, threadId, type: "message.created", data: serializeMessage(msg) });
  return msg;
}
