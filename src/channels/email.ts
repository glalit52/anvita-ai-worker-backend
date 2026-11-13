import { config } from "../config.js";
import { sendEmail } from "../services/email.js";
import { endpointById, endpointWorker, type Endpoint } from "./endpoints.js";
import { routeInbound } from "./common.js";

/**
 * Inbound email: a provider (Postmark, SendGrid Inbound Parse, Mailgun routes, Resend, or any
 * service that POSTs JSON or a form) forwards mail to the endpoint's webhook. Each sender gets
 * one conversation; the Worker's answer is emailed back as a reply from the endpoint's address.
 */

export interface InboundEmail { from: string; fromName: string; subject: string; text: string; messageId: string | null }

const addr = (s: string) => {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim().toLowerCase();
};
const nameOf = (s: string) => (/^\s*"?([^"<]+?)"?\s*</.exec(s)?.[1] ?? s.split("@")[0]).trim();
const header = (headers: unknown, name: string): string | null => {
  if (Array.isArray(headers)) return (headers as { Name?: string; name?: string; Value?: string; value?: string }[]).find((h) => (h.Name ?? h.name ?? "").toLowerCase() === name)?.Value ?? null;
  if (typeof headers === "string") return new RegExp(`^${name}:\\s*(.+)$`, "im").exec(headers)?.[1]?.trim() ?? null;
  return null;
};

/** Drop quoted history and signatures so the Worker sees only the new message. */
export function stripReply(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .{4,200} wrote:$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/.test(l) || l.trim() === "--") break;
    if (l.startsWith(">")) continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

/** Normalise Postmark / SendGrid / Mailgun / generic JSON payloads. */
export function parseInbound(b: Record<string, unknown>): InboundEmail | null {
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  const fromRaw = s("From") || s("from") || s("sender") || (b.from && typeof b.from === "object" ? String((b.from as { email?: string }).email ?? "") : "");
  if (!fromRaw) return null;
  const text = s("StrippedTextReply") || s("TextBody") || s("stripped-text") || s("body-plain") || s("text") || s("plain");
  return {
    from: addr(fromRaw),
    fromName: (b.FromFull as { Name?: string } | undefined)?.Name || nameOf(fromRaw),
    subject: s("Subject") || s("subject") || "(no subject)",
    text: stripReply(text),
    messageId: s("MessageID") || s("Message-Id") || s("messageId") || header(b.Headers ?? b.headers, "message-id"),
  };
}

export const emailRef = (e: Endpoint, sender: string) => `email:${e.id}:${sender}`;

export async function handleInboundEmail(e: Endpoint, mail: InboundEmail) {
  const allowed = ((e.config.allowedSenders as string[] | undefined) ?? []).map((x) => x.toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.some((a) => mail.from === a || mail.from.endsWith(`@${a.replace(/^@/, "")}`))) return { ignored: "sender not allowed" };
  if (mail.from === String(e.config.address ?? "").toLowerCase()) return { ignored: "own address" };
  if (!mail.text) return { ignored: "empty" };
  const worker = await endpointWorker(e);
  const r = await routeInbound({ workspaceId: e.workspaceId, ref: emailRef(e, mail.from), title: mail.subject.replace(/^(re|fwd?):\s*/i, ""), channel: "email", channelLabel: `Email · ${e.name}`, workerId: worker?.id, author: `${mail.fromName} <${mail.from}>`, text: mail.subject && !/^re:/i.test(mail.subject) ? `Subject: ${mail.subject}\n\n${mail.text}` : mail.text, trigger: "Email" });
  return { threadId: r.thread.id, runId: r.run?.id ?? null, handedOff: r.handedOff };
}

/** Reply to a sender (`email:<endpoint>:<address>`). */
export async function sendEmailReply(ref: string, subject: string, markdown: string) {
  const [, endpointId, to] = ref.split(":");
  const e = await endpointById(endpointId);
  if (!e) throw new Error("This email channel was removed");
  const from = String(e.config.address ?? "") || config.EMAIL_FROM;
  const sent = await sendEmail({ to, from: e.config.fromName ? `${String(e.config.fromName)} <${from.replace(/^.*<|>$/g, "")}>` : from, replyTo: from, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text: markdown.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)") });
  if (!sent && config.NODE_ENV === "production") throw new Error("Email isn't configured (RESEND_API_KEY)");
  return true;
}
