import { decideApproval, deciderFor } from "../services/approval-alerts.js";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { makeCaller } from "../connectors/http.js";
import { db } from "../db/client.js";
import { connections, workers } from "../db/schema.js";
import { hmacSha256, safeEqual } from "../lib/crypto.js";
import { parseCredentials } from "../connectors/index.js";
import { connectionByExternalId, routeInbound } from "./common.js";

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
    messages?: { id: string; from: string; type: string; text?: { body: string }; button?: { text: string; payload?: string }; interactive?: { button_reply?: { id?: string; title: string }; list_reply?: { title: string } } }[];
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
    // Approve / Reject reply buttons on an approval request.
    const choice = m.interactive?.button_reply?.id ?? m.button?.payload;
    if (choice?.startsWith("apr:")) {
      const [, approvalId, decision] = choice.split(":");
      const who = await deciderFor(conn.workspaceId, { phone: m.from });
      if (!who) {
        await sendWhatsApp(conn, m.from, "This number isn't linked to an Anvita member. Add it in Settings → Profile.");
        continue;
      }
      try {
        const row = await decideApproval(conn.workspaceId, approvalId, who, decision === "approved" ? "approved" : "rejected", { via: "whatsapp" });
        await sendWhatsApp(conn, m.from, `${row.status === "approved" ? "✅ Approved" : "❌ Rejected"}: ${row.title}`);
      } catch (e) {
        await sendWhatsApp(conn, m.from, (e as Error).message);
      }
      continue;
    }
    const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
    if (!text) {
      await sendWhatsApp(conn, m.from, "Sorry, I can only read text messages right now.");
      continue;
    }
    const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? `+${m.from}`;
    const worker = await workerFor(conn.workspaceId);
    await routeInbound({ workspaceId: conn.workspaceId, ref: `wa:${v.metadata.phone_number_id}:${m.from}`, title: `${name} · WhatsApp`, channel: "whatsapp", channelLabel: worker ? `WhatsApp · ${worker.name}` : "WhatsApp", workerId: worker?.id, author: name, text, trigger: "WhatsApp" });
  }
}

export async function sendWhatsApp(conn: { id: string; credentials: NonNullable<ReturnType<typeof parseCredentials>> }, to: string, text: string) {
  const call = makeCaller("whatsapp", conn.id, conn.credentials);
  // WhatsApp caps text bodies at 4096 characters.
  for (let i = 0; i < text.length; i += 4000) {
    await call("https://graph.facebook.com/v21.0/{phone_number_id}/messages", { body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: text.slice(i, i + 4000) } } });
  }
}
