import { eq } from "drizzle-orm";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { subscriptions } from "../src/db/schema.js";
import { hmacSha256 } from "../src/lib/crypto.js";
import { billingCycle } from "../src/services/subscriptions.js";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
let mock: MockAgent;
let original: Dispatcher;
const json = { headers: { "content-type": "application/json" } };

beforeAll(async () => {
  ctx = await setup();
  original = getGlobalDispatcher();
});
afterAll(async () => {
  setGlobalDispatcher(original);
  await ctx.app.close();
});
beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});

const signed = (url: string, body: object, headers: (raw: string) => Record<string, string>) => {
  const raw = JSON.stringify(body);
  return ctx.app.inject({ method: "POST", url, payload: raw, headers: { "content-type": "application/json", ...headers(raw) } });
};
const rzpSig = (raw: string) => ({ "x-razorpay-signature": hmacSha256("rzp_whsec", raw) });
const stripeSig = (raw: string) => {
  const t = Math.floor(Date.now() / 1000);
  return { "stripe-signature": `t=${t},v1=${hmacSha256("whsec_stripe", `${t}.${raw}`)}` };
};
const expire = (workspaceId: string) => db.update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() - 60_000) }).where(eq(subscriptions.workspaceId, workspaceId));

describe("plans", () => {
  it("starts on a Business trial, falls back to Starter and enforces its limits", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const plans = (await api.get("/v1/billing/plans")).body;
    expect(plans.plans.map((p: any) => p.id)).toEqual(["starter", "growth", "business", "enterprise"]);
    expect(plans.plans[1]).toMatchObject({ price: 4999, yearlyPrice: 49990 });
    expect(plans.subscription).toMatchObject({ plan: "business", status: "trialing" });
    expect(plans.subscription.trialEndsAt).toBeTruthy();

    await expire(s.workspaceId);
    await billingCycle();
    const after = (await api.get("/v1/billing/plans")).body;
    expect(after.subscription).toMatchObject({ plan: "starter", status: "active", provider: "free" });
    expect((await api.get("/v1/billing")).body.plan).toBe("starter");

    // Features outside Starter answer 402 with an upgrade hint.
    const mcp = await api.post("/v1/mcp-servers", { name: "x", url: "https://mcp.example.com" });
    expect(mcp.status).toBe(402);
    expect(mcp.body.error).toMatchObject({ code: "plan_limit", details: { feature: "mcp", upgradeTo: "Growth" } });
    expect((await api.patch("/v1/workspace/settings", { "security.piiRedaction": true })).status).toBe(402);

    // Starter allows three members (the owner counts).
    expect((await api.post("/v1/members", { name: "A", email: "a@acme.in", role: "member" })).status).toBe(201);
    expect((await api.post("/v1/members", { name: "B", email: "b@acme.in", role: "member" })).status).toBe(201);
    const third = await api.post("/v1/members", { name: "C", email: "c@acme.in", role: "member" });
    expect(third.status).toBe(402);
    expect(third.body.error.message).toMatch(/Starter plan includes 3 members/);
  });

  it("subscribes through Razorpay; each charge renews the plan and issues one GST invoice", async () => {
    let subBody: any;
    mock.get("https://api.razorpay.com").intercept({ path: "/v1/plans", method: "POST" }).reply(200, { id: "plan_growth" }, json);
    mock.get("https://api.razorpay.com").intercept({ path: "/v1/subscriptions", method: "POST" }).reply((o) => ((subBody = JSON.parse(String(o.body))), { statusCode: 200, data: { id: "sub_rzp1", short_url: "https://rzp.io/i/abc" }, responseOptions: json }));
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    // Billing profile: a Karnataka GSTIN (same state as the seller) → CGST + SGST.
    expect((await api.put("/v1/billing/profile", { gstin: "29ABCDE1234F1Z" })).status).toBe(400);
    const prof = (await api.put("/v1/billing/profile", { legalName: "Acme Foods Pvt Ltd", gstin: "29abcde1234f1z5", address: "MG Road, Bengaluru" })).body;
    expect(prof).toMatchObject({ gstin: "29ABCDE1234F1Z5", stateCode: "29", country: "IN" });

    const r = (await api.post("/v1/billing/subscribe", { plan: "growth", interval: "month" })).body;
    expect(r).toMatchObject({ mode: "checkout", provider: "razorpay", subscriptionId: "sub_rzp1", url: "https://rzp.io/i/abc" });
    expect(subBody.notes).toMatchObject({ workspaceId: s.workspaceId, plan: "growth", interval: "month" });
    expect(r.subscription.pendingPlan).toBe("growth");

    const before = (await api.get("/v1/billing")).body.creditsTotal;
    const now = Math.floor(Date.now() / 1000);
    const hook = { event: "subscription.charged", payload: { subscription: { entity: { id: "sub_rzp1", notes: { workspaceId: s.workspaceId, plan: "growth", interval: "month" }, current_start: now, current_end: now + 30 * 86400 } }, payment: { entity: { id: "pay_sub1" } } } };
    expect((await signed("/v1/hooks/razorpay", hook, rzpSig)).statusCode).toBe(200);
    expect((await signed("/v1/hooks/razorpay", hook, rzpSig)).statusCode).toBe(200);
    const sub = (await api.get("/v1/billing/plans")).body.subscription;
    expect(sub).toMatchObject({ plan: "growth", status: "active", provider: "razorpay", pendingPlan: null });
    expect((await api.get("/v1/billing")).body.creditsTotal).toBe(before + 50_000);

    const invoices = (await api.get("/v1/billing/invoices")).body.data;
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ kind: "subscription", status: "paid", subtotal: 4999, cgst: 449.91, sgst: 449.91, igst: 0, total: 5898.82 });
    expect(invoices[0].number).toMatch(/^ANV\/\d{4}-\d{2}\/\d{6}$/);
    const pdf = await ctx.app.inject({ method: "GET", url: `/v1/billing/invoices/${invoices[0].id}/pdf`, headers: { authorization: `Bearer ${s.token}` } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");

    // A failed charge marks it past due; cancelling ends it at the provider.
    expect((await signed("/v1/hooks/razorpay", { event: "subscription.halted", payload: { subscription: { entity: { id: "sub_rzp1" } } } }, rzpSig)).statusCode).toBe(200);
    expect((await api.get("/v1/billing/plans")).body.subscription.status).toBe("past_due");
    mock.get("https://api.razorpay.com").intercept({ path: "/v1/subscriptions/sub_rzp1/cancel", method: "POST" }).reply(200, { id: "sub_rzp1" }, json);
    expect((await api.post("/v1/billing/subscription/cancel")).body).toMatchObject({ cancelAtPeriodEnd: true, pendingPlan: "starter" });
    await expire(s.workspaceId);
    await billingCycle();
    expect((await api.get("/v1/billing/plans")).body.subscription).toMatchObject({ plan: "starter", provider: "free" });
  });

  it("subscribes through Stripe with IGST for another state, and downgrades when Stripe ends it", async () => {
    let form = "";
    mock.get("https://api.stripe.com").intercept({ path: "/v1/checkout/sessions", method: "POST" }).reply((o) => ((form = decodeURIComponent(String(o.body))), { statusCode: 200, data: { id: "cs_sub", url: "https://checkout.stripe.com/c/cs_sub" }, responseOptions: json }));
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.put("/v1/billing/profile", { legalName: "Kesar Foods LLP", gstin: "27ABCDE1234F1Z5" });
    const r = (await api.post("/v1/billing/subscribe", { plan: "business", interval: "year", provider: "stripe" })).body;
    expect(r).toMatchObject({ mode: "checkout", provider: "stripe", url: "https://checkout.stripe.com/c/cs_sub" });
    expect(form).toContain("mode=subscription");
    expect(form).toContain("line_items[0][price_data][recurring][interval]=year");
    expect(form).toContain(`line_items[0][price_data][unit_amount]=${Math.round(199990 * 1.18 * 100)}`);

    const invoice = { type: "invoice.paid", data: { object: { id: "in_1", subscription: "sub_stripe1", subscription_details: { metadata: { workspaceId: s.workspaceId, plan: "business", interval: "year" } }, lines: { data: [{ period: { start: 1_800_000_000, end: 1_831_536_000 } }] } } } };
    expect((await signed("/v1/hooks/stripe", invoice, stripeSig)).statusCode).toBe(200);
    expect((await api.get("/v1/billing/plans")).body.subscription).toMatchObject({ plan: "business", interval: "year", status: "active", provider: "stripe" });
    const [inv] = (await api.get("/v1/billing/invoices")).body.data;
    expect(inv).toMatchObject({ subtotal: 199990, cgst: 0, sgst: 0, igst: 35998.2, total: 235988.2 });

    expect((await signed("/v1/hooks/stripe", { type: "customer.subscription.deleted", data: { object: { id: "sub_stripe1" } } }, stripeSig)).statusCode).toBe(200);
    expect((await api.get("/v1/billing/plans")).body.subscription).toMatchObject({ plan: "starter" });
    expect((await api.get("/v1/audit")).body.data.some((a: any) => a.action === "billing.downgraded")).toBe(true);
  });

  it("issues a tax invoice for credit purchases and refuses Enterprise self-serve", async () => {
    mock.get("https://api.razorpay.com").intercept({ path: "/v1/orders", method: "POST" }).reply(200, { id: "order_inv" }, json);
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.post("/v1/billing/checkout", { credits: 50000, provider: "razorpay" });
    await api.post("/v1/billing/razorpay/verify", { orderId: "order_inv", paymentId: "pay_inv", signature: hmacSha256("rzp_secret", "order_inv|pay_inv") });
    const [inv] = (await api.get("/v1/billing/invoices")).body.data;
    expect(inv).toMatchObject({ kind: "credits", status: "paid", subtotal: 5000, total: 5900 });
    expect((await api.post("/v1/billing/subscribe", { plan: "enterprise" })).status).toBe(400);
  });
});
