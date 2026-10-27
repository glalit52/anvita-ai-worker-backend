import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { webhookDeliveries, webhooks } from "../db/schema.js";
import { hmacSha256 } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { enqueue } from "../jobs/queue.js";

export const WEBHOOK_EVENTS = ["run.completed", "run.failed", "approval.requested", "approval.decided", "worker.published", "usage.threshold"] as const;

/** Fan an event out to every active subscription; delivery happens in the job queue with retries. */
export async function emitWebhook(workspaceId: string, event: string, data: unknown) {
  const subs = await db.select().from(webhooks).where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.active, true)));
  for (const s of subs) {
    if (!s.events.includes(event) && !s.events.includes("*")) continue;
    const id = newId("whd");
    const payload = { id, type: event, createdAt: new Date().toISOString(), workspaceId, data };
    await db.insert(webhookDeliveries).values({ id, webhookId: s.id, workspaceId, event, payload });
    await enqueue("webhook.deliver", { deliveryId: id }, { maxAttempts: 8 });
  }
}

/** POST with `Anvita-Signature: t=<unix>,v1=<hmac_sha256(secret, "<t>.<body>")>` (Stripe-style, replay-resistant). */
export async function deliverWebhook(deliveryId: string) {
  const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId));
  if (!d || d.status === "delivered") return;
  const [hook] = await db.select().from(webhooks).where(eq(webhooks.id, d.webhookId));
  if (!hook || !hook.active) return;
  const body = JSON.stringify(d.payload);
  const t = Math.floor(Date.now() / 1000);
  let status = 0;
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Anvita-Webhooks/1.0", "Anvita-Event": d.event, "Anvita-Delivery": d.id, "Anvita-Signature": `t=${t},v1=${hmacSha256(hook.secret, `${t}.${body}`)}` },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    status = res.status;
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    await db.update(webhookDeliveries).set({ status: "delivered", attempts: d.attempts + 1, responseCode: status, deliveredAt: new Date(), lastError: null }).where(eq(webhookDeliveries.id, d.id));
  } catch (e) {
    await db.update(webhookDeliveries).set({ status: "failed", attempts: d.attempts + 1, responseCode: status || null, lastError: (e as Error).message.slice(0, 500) }).where(eq(webhookDeliveries.id, d.id));
    throw e; // let the job queue retry with backoff
  }
}
