import { and, eq, inArray, lt } from "drizzle-orm";
import { config } from "../config.js";
import { db, type Tx } from "../db/client.js";
import { invoices, providerPlans, subscriptions, workspaces } from "../db/schema.js";
import { badRequest } from "../lib/errors.js";
import { audit } from "./audit.js";
import { getBalance, grant } from "./credits.js";
import { publish } from "./events.js";
import { issueInvoice, taxSplit, billingProfile } from "./invoices.js";
import { notify } from "./notifications.js";
import { providers } from "./payments.js";
import { periodPrice, planById, type PlanId } from "./plans.js";

/**
 * Subscriptions. New workspaces start a Business trial and fall back to Starter (free) when it
 * ends. Paid plans renew through Razorpay or Stripe subscriptions: every successful charge
 * (webhook) extends the period, grants the plan's credits and issues a paid GST invoice. Without
 * a payment provider (self-hosted / development) plan changes take effect at once with a due
 * invoice.
 */

export type Sub = typeof subscriptions.$inferSelect;
type Interval = "month" | "year";

const addPeriod = (d: Date, interval: Interval) => {
  const n = new Date(d);
  if (interval === "year") n.setUTCFullYear(n.getUTCFullYear() + 1);
  else n.setUTCMonth(n.getUTCMonth() + 1);
  return n;
};

export async function getSubscription(workspaceId: string, tx: Tx = db): Promise<Sub> {
  const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  if (s) return s;
  // Workspaces created before subscriptions existed: treat as Starter.
  const now = new Date();
  const [created] = await tx.insert(subscriptions).values({ workspaceId, plan: "starter", provider: "free", status: "active", currentPeriodStart: now, currentPeriodEnd: addPeriod(now, "month") }).onConflictDoNothing().returning();
  return created ?? (await tx.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId)))[0];
}

/** Called when a workspace is created. */
export async function startTrial(workspaceId: string, tx: Tx) {
  const now = new Date();
  const trial = config.TRIAL_DAYS > 0;
  const end = new Date(now.getTime() + (trial ? config.TRIAL_DAYS : 30) * 86400_000);
  await tx.insert(subscriptions).values({ workspaceId, plan: trial ? "business" : "starter", status: trial ? "trialing" : "active", provider: "free", currentPeriodStart: now, currentPeriodEnd: end, trialEndsAt: trial ? end : null });
  await tx.update(workspaces).set({ plan: trial ? "business" : "starter", renewsAt: end }).where(eq(workspaces.id, workspaceId));
}

async function setWorkspacePlan(workspaceId: string, plan: PlanId, renewsAt: Date) {
  await db.update(workspaces).set({ plan, renewsAt }).where(eq(workspaces.id, workspaceId));
}

async function changed(workspaceId: string) {
  await publish({ workspaceId, type: "billing.updated", data: await getBalance(workspaceId) });
}

/**
 * A paid (or free / manual) period starts: plan, period, credits and invoice. Idempotent per
 * `paymentRef` (provider payment or invoice id).
 */
export async function activatePeriod(workspaceId: string, o: { plan: PlanId; interval: Interval; provider: Sub["provider"]; providerRef?: string | null; paymentRef?: string | null; start?: Date; end?: Date; invoiceStatus?: "paid" | "due" }) {
  const plan = planById[o.plan];
  const before = await getSubscription(workspaceId);
  const invoiceRef = o.paymentRef ? `${o.provider}:${o.paymentRef}` : null;
  const price = periodPrice(plan, o.interval);
  // Already processed this payment? (webhook retries, or checkout + webhook both confirming)
  if (invoiceRef) {
    const [seen] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.providerRef, invoiceRef));
    if (seen) return before;
  }
  if (price > 0) await issueInvoice({ workspaceId, kind: "subscription", description: `Anvita ${plan.name} plan — ${o.interval === "year" ? "annual" : "monthly"} subscription`, subtotal: price, status: o.invoiceStatus ?? "paid", providerRef: invoiceRef, periodStart: o.start ?? new Date(), periodEnd: o.end ?? addPeriod(o.start ?? new Date(), o.interval) });
  const start = o.start ?? new Date();
  const end = o.end ?? addPeriod(start, o.interval);
  // Switching paid subscriptions: stop the old one at the provider.
  if (before.providerRef && o.providerRef && before.providerRef !== o.providerRef) await cancelAtProvider(before, true).catch(() => {});
  const [s] = await db
    .update(subscriptions)
    .set({ plan: o.plan, interval: o.interval, provider: o.provider, providerRef: o.providerRef ?? null, status: "active", currentPeriodStart: start, currentPeriodEnd: end, trialEndsAt: null, cancelAtPeriodEnd: false, pendingPlan: null, updatedAt: new Date() })
    .where(eq(subscriptions.workspaceId, workspaceId))
    .returning();
  await grant(workspaceId, plan.credits * (o.interval === "year" ? 12 : 1), "plan_grant", { plan: plan.id, interval: o.interval, period: start.toISOString() });
  await setWorkspacePlan(workspaceId, o.plan, end);
  await audit({ workspaceId, actor: "Billing", actorType: "system", action: before.plan === o.plan && before.status === "active" ? "billing.renewed" : "billing.plan_changed", target: `${plan.name} (${o.interval}ly) until ${end.toISOString().slice(0, 10)}` });
  await changed(workspaceId);
  return s;
}

export async function downgradeToStarter(workspaceId: string, reason: string) {
  const now = new Date();
  const end = addPeriod(now, "month");
  await db.update(subscriptions).set({ plan: "starter", interval: "month", status: "active", provider: "free", providerRef: null, currentPeriodStart: now, currentPeriodEnd: end, trialEndsAt: null, cancelAtPeriodEnd: false, pendingPlan: null, updatedAt: now }).where(eq(subscriptions.workspaceId, workspaceId));
  await grant(workspaceId, planById.starter.credits, "plan_grant", { plan: "starter", period: now.toISOString() });
  await setWorkspacePlan(workspaceId, "starter", end);
  await audit({ workspaceId, actor: "Billing", actorType: "system", action: "billing.downgraded", target: `Starter (${reason})` });
  await notify({ workspaceId, appId: "anvita", title: `Your workspace moved to the Starter plan (${reason})`, meta: "Billing · just now", href: "/settings/billing", minRole: "admin" });
  await changed(workspaceId);
}

// ─── Providers ─────────────────────────────────────────────────────────────────

async function provider<T>(url: string, init: { method?: string; auth: string; form?: Record<string, string>; json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? "POST",
    headers: { Authorization: init.auth, ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : init.json ? { "Content-Type": "application/json" } : {}) },
    body: init.form ? new URLSearchParams(init.form).toString() : init.json ? JSON.stringify(init.json) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; description?: string } };
  if (!res.ok) throw badRequest(`Payment provider error: ${data.error?.description ?? data.error?.message ?? res.status}`);
  return data;
}
const rzpAuth = () => `Basic ${Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString("base64")}`;
const stripeAuth = () => `Bearer ${config.STRIPE_SECRET_KEY}`;

async function razorpayPlanId(planId: PlanId, interval: Interval, amountPaise: number) {
  const key = `razorpay:${planId}:${interval}:${amountPaise}`;
  const [hit] = await db.select().from(providerPlans).where(eq(providerPlans.key, key));
  if (hit) return hit.providerId;
  const plan = await provider<{ id: string }>("https://api.razorpay.com/v1/plans", { auth: rzpAuth(), json: { period: interval === "year" ? "yearly" : "monthly", interval: 1, item: { name: `Anvita ${planById[planId].name} (${interval}ly)`, amount: amountPaise, currency: config.BILLING_CURRENCY.toUpperCase() } } });
  await db.insert(providerPlans).values({ key, providerId: plan.id }).onConflictDoNothing();
  return plan.id;
}

async function cancelAtProvider(s: Sub, immediately: boolean) {
  if (!s.providerRef) return;
  if (s.provider === "stripe") {
    if (immediately) await provider(`https://api.stripe.com/v1/subscriptions/${s.providerRef}`, { method: "DELETE", auth: stripeAuth() });
    else await provider(`https://api.stripe.com/v1/subscriptions/${s.providerRef}`, { auth: stripeAuth(), form: { cancel_at_period_end: "true" } });
  } else if (s.provider === "razorpay") {
    await provider(`https://api.razorpay.com/v1/subscriptions/${s.providerRef}/cancel`, { auth: rzpAuth(), json: { cancel_at_cycle_end: immediately ? 0 : 1 } });
  }
}

/**
 * Change plan. Free plans and setups without a payment provider switch immediately; paid plans
 * return a checkout (Stripe URL or Razorpay subscription) — the switch happens when it's paid.
 */
export async function subscribe(workspaceId: string, o: { plan: PlanId; interval: Interval; provider?: "razorpay" | "stripe"; actor: { id: string | null; name: string } }) {
  const plan = planById[o.plan];
  if (!plan) throw badRequest("Unknown plan");
  if (plan.price === null) throw badRequest("Enterprise is set up by our team — contact sales@anvita.ai");
  const current = await getSubscription(workspaceId);
  if (plan.price === 0) {
    if (current.provider === "stripe" || current.provider === "razorpay") {
      await cancelAtProvider(current, false);
      await db.update(subscriptions).set({ cancelAtPeriodEnd: true, pendingPlan: "starter", updatedAt: new Date() }).where(eq(subscriptions.workspaceId, workspaceId));
      return { mode: "scheduled" as const, at: current.currentPeriodEnd.toISOString() };
    }
    await downgradeToStarter(workspaceId, `changed by ${o.actor.name}`);
    return { mode: "activated" as const };
  }

  const avail = providers();
  const via = o.provider ?? (avail.razorpay ? "razorpay" : avail.stripe ? "stripe" : null);
  if (!via) {
    // No payment provider: switch now and invoice for offline payment.
    await activatePeriod(workspaceId, { plan: o.plan, interval: o.interval, provider: "manual", invoiceStatus: "due" });
    return { mode: "activated" as const };
  }
  if (!avail[via]) throw badRequest(`${via} isn't configured on this server`);
  const subtotal = periodPrice(plan, o.interval);
  const { total } = taxSplit(subtotal, await billingProfile(workspaceId));
  const amount = Math.round(total * 100);
  await db.update(subscriptions).set({ pendingPlan: o.plan, updatedAt: new Date() }).where(eq(subscriptions.workspaceId, workspaceId));
  const notes = { workspaceId, plan: o.plan, interval: o.interval };

  if (via === "razorpay") {
    const planId = await razorpayPlanId(o.plan, o.interval, amount);
    const sub = await provider<{ id: string; short_url: string }>("https://api.razorpay.com/v1/subscriptions", { auth: rzpAuth(), json: { plan_id: planId, total_count: o.interval === "year" ? 10 : 120, quantity: 1, customer_notify: 1, notes } });
    return { mode: "checkout" as const, provider: "razorpay" as const, subscriptionId: sub.id, keyId: config.RAZORPAY_KEY_ID, url: sub.short_url };
  }
  const session = await provider<{ id: string; url: string }>("https://api.stripe.com/v1/checkout/sessions", {
    auth: stripeAuth(),
    form: {
      mode: "subscription",
      success_url: `${config.WEB_URL}/settings/billing?checkout=success`,
      cancel_url: `${config.WEB_URL}/settings/billing?checkout=cancelled`,
      client_reference_id: workspaceId,
      "metadata[workspaceId]": workspaceId,
      "metadata[plan]": o.plan,
      "metadata[interval]": o.interval,
      "subscription_data[metadata][workspaceId]": workspaceId,
      "subscription_data[metadata][plan]": o.plan,
      "subscription_data[metadata][interval]": o.interval,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": config.BILLING_CURRENCY.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(amount),
      "line_items[0][price_data][recurring][interval]": o.interval,
      "line_items[0][price_data][product_data][name]": `Anvita ${plan.name}`,
    },
  });
  return { mode: "checkout" as const, provider: "stripe" as const, url: session.url };
}

export async function cancelSubscription(workspaceId: string, actor: string) {
  const s = await getSubscription(workspaceId);
  if (s.plan === "starter") throw badRequest("You're on the free plan");
  if (s.status === "trialing") {
    await downgradeToStarter(workspaceId, `trial ended early by ${actor}`);
    return getSubscription(workspaceId);
  }
  await cancelAtProvider(s, false);
  const [u] = await db.update(subscriptions).set({ cancelAtPeriodEnd: true, pendingPlan: "starter", updatedAt: new Date() }).where(eq(subscriptions.workspaceId, workspaceId)).returning();
  await audit({ workspaceId, actor, action: "billing.cancelled", target: `${planById[s.plan as PlanId]?.name ?? s.plan} ends ${s.currentPeriodEnd.toISOString().slice(0, 10)}` });
  return u;
}

export async function resumeSubscription(workspaceId: string, actor: string) {
  const s = await getSubscription(workspaceId);
  if (!s.cancelAtPeriodEnd) return s;
  if (s.provider === "stripe" && s.providerRef) await provider(`https://api.stripe.com/v1/subscriptions/${s.providerRef}`, { auth: stripeAuth(), form: { cancel_at_period_end: "false" } });
  if (s.provider === "razorpay") throw badRequest("Razorpay subscriptions can't be resumed after cancelling — subscribe again");
  const [u] = await db.update(subscriptions).set({ cancelAtPeriodEnd: false, pendingPlan: null, updatedAt: new Date() }).where(eq(subscriptions.workspaceId, workspaceId)).returning();
  await audit({ workspaceId, actor, action: "billing.resumed", target: planById[s.plan as PlanId]?.name ?? s.plan });
  return u;
}

// ─── Webhooks ──────────────────────────────────────────────────────────────────

type StripeObj = { id?: string; mode?: string; subscription?: string; metadata?: Record<string, string>; amount_paid?: number; lines?: { data?: { period?: { start: number; end: number } }[] }; subscription_details?: { metadata?: Record<string, string> }; parent?: { subscription_details?: { metadata?: Record<string, string>; subscription?: string } } };

export async function handleStripeSubscriptionEvent(type: string, o: StripeObj) {
  if (type === "invoice.paid" || type === "invoice.payment_succeeded") {
    const meta = o.subscription_details?.metadata ?? o.parent?.subscription_details?.metadata ?? {};
    const subId = o.subscription ?? o.parent?.subscription_details?.subscription;
    if (!meta.workspaceId || !subId || !o.id) return false;
    const period = o.lines?.data?.[0]?.period;
    await activatePeriod(meta.workspaceId, { plan: meta.plan as PlanId, interval: (meta.interval as Interval) ?? "month", provider: "stripe", providerRef: subId, paymentRef: o.id, start: period ? new Date(period.start * 1000) : undefined, end: period ? new Date(period.end * 1000) : undefined });
    return true;
  }
  if (type === "customer.subscription.deleted" && o.id) {
    const [s] = await db.select().from(subscriptions).where(and(eq(subscriptions.provider, "stripe"), eq(subscriptions.providerRef, o.id)));
    if (s) await downgradeToStarter(s.workspaceId, "subscription ended");
    return true;
  }
  if (type === "invoice.payment_failed" && o.subscription) {
    await markPastDue("stripe", o.subscription);
    return true;
  }
  return false;
}

type RzpPayload = { subscription?: { entity?: { id: string; notes?: Record<string, string>; current_start?: number; current_end?: number } }; payment?: { entity?: { id: string } } };

export async function handleRazorpaySubscriptionEvent(event: string, p: RzpPayload) {
  const sub = p.subscription?.entity;
  if (!sub) return false;
  if (event === "subscription.charged") {
    const n = sub.notes ?? {};
    if (!n.workspaceId || !p.payment?.entity?.id) return false;
    await activatePeriod(n.workspaceId, { plan: n.plan as PlanId, interval: (n.interval as Interval) ?? "month", provider: "razorpay", providerRef: sub.id, paymentRef: p.payment.entity.id, start: sub.current_start ? new Date(sub.current_start * 1000) : undefined, end: sub.current_end ? new Date(sub.current_end * 1000) : undefined });
    return true;
  }
  if (event === "subscription.cancelled" || event === "subscription.completed") {
    const [s] = await db.select().from(subscriptions).where(and(eq(subscriptions.provider, "razorpay"), eq(subscriptions.providerRef, sub.id)));
    if (s && !s.cancelAtPeriodEnd) await downgradeToStarter(s.workspaceId, "subscription ended");
    return true;
  }
  if (event === "subscription.halted" || event === "subscription.pending") {
    await markPastDue("razorpay", sub.id);
    return true;
  }
  return false;
}

async function markPastDue(prov: "stripe" | "razorpay", ref: string) {
  const [s] = await db.update(subscriptions).set({ status: "past_due", updatedAt: new Date() }).where(and(eq(subscriptions.provider, prov), eq(subscriptions.providerRef, ref))).returning();
  if (s) await notify({ workspaceId: s.workspaceId, appId: "anvita", title: "Payment for your Anvita subscription failed — update your payment method", meta: "Billing · just now", href: "/settings/billing", minRole: "admin" });
}

// ─── Daily cycle ───────────────────────────────────────────────────────────────

const GRACE_DAYS = 7;

/** Trials ending, cancellations taking effect, free / manual renewals, unpaid subscriptions. */
export async function billingCycle(now = new Date()) {
  const due = await db.select().from(subscriptions).where(lt(subscriptions.currentPeriodEnd, now));
  for (const s of due) {
    if (s.status === "trialing") await downgradeToStarter(s.workspaceId, "trial ended");
    else if (s.cancelAtPeriodEnd) await downgradeToStarter(s.workspaceId, "subscription cancelled");
    else if (s.provider === "free") {
      const end = addPeriod(s.currentPeriodEnd, "month");
      await db.update(subscriptions).set({ currentPeriodStart: s.currentPeriodEnd, currentPeriodEnd: end, updatedAt: now }).where(eq(subscriptions.workspaceId, s.workspaceId));
      await grant(s.workspaceId, planById.starter.credits, "plan_grant", { plan: "starter", period: s.currentPeriodEnd.toISOString() });
      await setWorkspacePlan(s.workspaceId, "starter", end);
    } else if (s.provider === "manual") {
      await activatePeriod(s.workspaceId, { plan: s.plan as PlanId, interval: s.interval, provider: "manual", start: s.currentPeriodEnd, invoiceStatus: "due" });
    } else if (now.getTime() - s.currentPeriodEnd.getTime() > GRACE_DAYS * 86400_000) {
      await downgradeToStarter(s.workspaceId, "payment not received");
    } else if (s.status !== "past_due") {
      await db.update(subscriptions).set({ status: "past_due", updatedAt: now }).where(eq(subscriptions.workspaceId, s.workspaceId));
    }
  }
  // Trials: remind three days before the end.
  const soon = await db.select().from(subscriptions).where(and(eq(subscriptions.status, "trialing"), inArray(subscriptions.provider, ["free"])));
  for (const s of soon) {
    const days = Math.ceil((s.currentPeriodEnd.getTime() - now.getTime()) / 86400_000);
    if (days === 3) await notify({ workspaceId: s.workspaceId, appId: "anvita", title: "Your Business trial ends in 3 days — choose a plan to keep SSO, unlimited Workers and more", meta: "Billing", href: "/settings/billing", minRole: "admin" });
  }
}
