import { and, eq, ne } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { payments } from "../db/schema.js";
import { hmacSha256, safeEqual } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { audit } from "./audit.js";
import { getBalance, grant } from "./credits.js";
import { publish } from "./events.js";

export const providers = () => ({ razorpay: !!(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET), stripe: !!config.STRIPE_SECRET_KEY });

export const priceFor = (credits: number) => Math.round((credits / 1000) * config.CREDITS_PRICE_PER_1000 * 100);

async function providerFetch<T>(url: string, init: { auth: string; form?: Record<string, string>; json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: init.auth, ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : { "Content-Type": "application/json" }) },
    body: init.form ? new URLSearchParams(init.form).toString() : JSON.stringify(init.json),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; description?: string } };
  if (!res.ok) throw badRequest(`Payment provider error: ${data.error?.description ?? data.error?.message ?? res.status}`);
  return data;
}

export async function createCheckout(input: { workspaceId: string; userId: string | null; credits: number; provider?: "razorpay" | "stripe" }) {
  const avail = providers();
  const provider = input.provider ?? (avail.razorpay ? "razorpay" : avail.stripe ? "stripe" : null);
  if (!provider || !avail[provider]) throw badRequest("No payment provider is configured on the server");
  const id = newId("pay");
  const amount = priceFor(input.credits);
  const currency = config.BILLING_CURRENCY.toUpperCase();

  if (provider === "razorpay") {
    const order = await providerFetch<{ id: string }>("https://api.razorpay.com/v1/orders", {
      auth: `Basic ${Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
      json: { amount, currency, receipt: id, notes: { workspaceId: input.workspaceId, credits: String(input.credits) } },
    });
    await db.insert(payments).values({ id, workspaceId: input.workspaceId, provider, providerRef: order.id, credits: input.credits, amount, currency, createdBy: input.userId });
    return { provider, paymentId: id, orderId: order.id, keyId: config.RAZORPAY_KEY_ID, amount, currency, credits: input.credits };
  }

  const session = await providerFetch<{ id: string; url: string }>("https://api.stripe.com/v1/checkout/sessions", {
    auth: `Bearer ${config.STRIPE_SECRET_KEY}`,
    form: {
      mode: "payment",
      success_url: `${config.WEB_URL}/settings/billing?checkout=success`,
      cancel_url: `${config.WEB_URL}/settings/billing?checkout=cancelled`,
      client_reference_id: id,
      "metadata[paymentId]": id,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(amount),
      "line_items[0][price_data][product_data][name]": `${input.credits.toLocaleString("en-IN")} Anvita credits`,
    },
  });
  await db.insert(payments).values({ id, workspaceId: input.workspaceId, provider, providerRef: session.id, credits: input.credits, amount, currency, createdBy: input.userId });
  return { provider, paymentId: id, url: session.url, amount, currency, credits: input.credits };
}

/** Mark paid and grant credits exactly once, however many confirmations arrive. */
export async function markPaid(provider: "razorpay" | "stripe", providerRef: string, meta: Record<string, unknown> = {}) {
  const [p] = await db.update(payments).set({ status: "paid", paidAt: new Date() }).where(and(eq(payments.provider, provider), eq(payments.providerRef, providerRef), ne(payments.status, "paid"))).returning();
  if (!p) return null;
  await grant(p.workspaceId, p.credits, "topup", { paymentId: p.id, provider, ...meta });
  await audit({ workspaceId: p.workspaceId, actor: "System", actorType: "system", action: "billing.topup", target: `${p.credits.toLocaleString("en-IN")} credits via ${provider}`, payload: { paymentId: p.id } });
  await publish({ workspaceId: p.workspaceId, type: "billing.updated", data: await getBalance(p.workspaceId) });
  return p;
}

/** Razorpay Checkout handler signature: hmac(key_secret, "<order_id>|<payment_id>"). */
export const verifyRazorpayPayment = (orderId: string, paymentId: string, signature: string) => !!config.RAZORPAY_KEY_SECRET && safeEqual(signature, hmacSha256(config.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`));
/** Razorpay webhook: hmac(webhook_secret, raw body). */
export const verifyRazorpayWebhook = (raw: string, signature: string | undefined) => !!config.RAZORPAY_WEBHOOK_SECRET && !!signature && safeEqual(signature, hmacSha256(config.RAZORPAY_WEBHOOK_SECRET, raw));
/** Stripe webhook: `t=<ts>,v1=<hmac(secret, "<ts>.<raw>")>`, 5-minute tolerance. */
export function verifyStripeWebhook(raw: string, header: string | undefined) {
  if (!config.STRIPE_WEBHOOK_SECRET || !header) return false;
  const t = /t=(\d+)/.exec(header)?.[1];
  const sigs = [...header.matchAll(/v1=([0-9a-f]+)/g)].map((m) => m[1]);
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = hmacSha256(config.STRIPE_WEBHOOK_SECRET, `${t}.${raw}`);
  return sigs.some((s) => safeEqual(s, expected));
}
