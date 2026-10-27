import { config } from "../config.js";

export interface Email { to: string; subject: string; text: string; html?: string }

/** Transactional email via Resend when configured; otherwise logged (dev). Returns whether it was sent. */
export async function sendEmail(msg: Email, log?: { info: (o: object, m: string) => void }): Promise<boolean> {
  if (!config.RESEND_API_KEY) {
    log?.info({ to: msg.to, subject: msg.subject }, "email (not sent: RESEND_API_KEY unset)");
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  return true;
}
