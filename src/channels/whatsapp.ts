import { and, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { makeCaller } from "../connectors/http.js";
import { db } from "../db/client.js";
import { connections, inboxConversations, messages, workers } from "../db/schema.js";
import { hmacSha256, safeEqual } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { startAgentRun } from "../modules/chat.js";
import { publish } from "../services/events.js";
import { serializeInbox, serializeMessage } from "../services/serializers.js";
import { parseCredentials } from "../connectors/index.js";
import { connectionByExternalId, ensureThread } from "./common.js";

/** Meta signs webhook bodies with the app secret: `sha256=<hex>`. */
export function verifyMetaSignature(rawBody: string, header: string | undefined, appSecret: string | undefined) {
  if (!header || !appSecret) return false;
  return safeEqual(header, `sha256=${hmacSha256(appSecret, rawBody)}`);
}

/** GET verification handshake: find the connection whose verify token matches. */
export async function verifyTokenMatches(token: string) {
  const rows = await db.select().from(connections).where(and(eq(connections.appId, "whatsapp"), eq(connections.mode, "live")));
  return rows.some((c) => parseCredentials(c.credentialsEnc)?.fields?.verify_token === token);
}

export interface WaChange {
  value: {
    metadata: { phone_number_id: string; display_phone_number?: string };
    contacts?: { wa_id: string; profile?: { name?: string } }[];
    messages?: { id: string; from: string; type: string; text?: { body: string }; button?: { text: string }; interactive?: { button_reply?: { title: string }; list_reply?: { title: string } } }[];
  };
}

/** The live, channel-bound Worker that answers this WhatsApp number (first match). */
async function workerFor(workspaceId: string) {
  const rows = await db.select().from(workers).where(and(eq(workers.workspaceId, workspaceId), inArray(workers.status, ["live", "canary"])));
  return rows.find((w) => w.channels.some((c) => /whatsapp/i.test(c))) ?? rows.find((w) => w.apps.includes("whatsapp") && w.interaction === "chat") ?? null;
}

export async function handleWhatsAppMessage(change: WaChange, log: FastifyBaseLogger) {
  const v = change.value;
  const conn = await connectionByExternalId("whatsapp", v.metadata.phone_number_id);
  if (!conn) return log.warn({ phone: v.metadata.phone_number_id }, "whatsapp message for unknown number");
  for (const m of v.messages ?? []) {
    const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
    if (!text) {
      await sendWhatsApp(conn, m.from, "Sorry, I can only read text messages right now.");
      continue;
    }
    const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? `+${m.from}`;
    const worker = await workerFor(conn.workspaceId);
    const thread = await ensureThread(conn.workspaceId, `wa:${v.metadata.phone_number_id}:${m.from}`, { title: `${name} · WhatsApp`, channel: "whatsapp", channelLabel: worker ? `WhatsApp · ${worker.name}` : "WhatsApp", workerId: worker?.id });

    // A teammate has taken over: record the message for them instead of running the Worker.
    const [handoff] = await db.select().from(inboxConversations).where(and(eq(inboxConversations.threadId, thread.id), eq(inboxConversations.status, "taken")));
    if (handoff) {
      const [c] = await db.update(inboxConversations).set({ transcript: [...handoff.transcript, { from: "customer", text, time: new Date().toISOString() }], updatedAt: new Date() }).where(eq(inboxConversations.id, handoff.id)).returning();
      await publish({ workspaceId: conn.workspaceId, type: "inbox.updated", data: serializeInbox(c) });
      const [msg] = await db.insert(messages).values({ id: newId("msg"), workspaceId: conn.workspaceId, threadId: thread.id, role: "user", author: name, blocks: [{ type: "text", text }] }).returning();
      await publish({ workspaceId: conn.workspaceId, threadId: thread.id, type: "message.created", data: serializeMessage(msg) });
      continue;
    }
    await startAgentRun({ userId: null, userName: name, email: null, workspaceId: conn.workspaceId, role: "member" }, thread.id, { text }, { workerId: worker?.id ?? null, trigger: "WhatsApp", customer: true });
  }
}

export async function sendWhatsApp(conn: { id: string; credentials: NonNullable<ReturnType<typeof parseCredentials>> }, to: string, text: string) {
  const call = makeCaller("whatsapp", conn.id, conn.credentials);
  // WhatsApp caps text bodies at 4096 characters.
  for (let i = 0; i < text.length; i += 4000) {
    await call("https://graph.facebook.com/v21.0/{phone_number_id}/messages", { body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: text.slice(i, i + 4000) } } });
  }
}
