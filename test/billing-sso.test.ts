import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hmacSha256 } from "../src/lib/crypto.js";
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

describe("payments", () => {
  it("Razorpay: order → checkout signature → credits granted exactly once (webhook too)", async () => {
    let orderBody: any;
    mock.get("https://api.razorpay.com").intercept({ path: "/v1/orders", method: "POST" }).reply((o) => ((orderBody = JSON.parse(String(o.body))), { statusCode: 200, data: { id: "order_1" }, responseOptions: json }));
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    expect((await api.get("/v1/billing/providers")).body).toMatchObject({ razorpay: true, stripe: true, pricePer1000: 100, packs: [{ credits: 50000, price: 5000, total: 5900 }, { credits: 100000, price: 9000 }, { credits: 250000, price: 20000, total: 23600 }] });
    const before = (await api.get("/v1/billing")).body.creditsTotal;

    const co = await api.post("/v1/billing/checkout", { credits: 50000, provider: "razorpay" });
    expect(co.body).toMatchObject({ provider: "razorpay", orderId: "order_1", keyId: "rzp_test_key", amount: 590000, currency: "INR" });
    expect(orderBody).toMatchObject({ amount: 590000, currency: "INR" });

    expect((await api.post("/v1/billing/razorpay/verify", { orderId: "order_1", paymentId: "pay_x", signature: "bad" })).status).toBe(400);
    const ok = await api.post("/v1/billing/razorpay/verify", { orderId: "order_1", paymentId: "pay_x", signature: hmacSha256("rzp_secret", "order_1|pay_x") });
    expect(ok.body.creditsTotal).toBe(before + 50000);

    // The webhook for the same order is a no-op; an unsigned one is rejected.
    const hook = { event: "order.paid", payload: { order: { entity: { id: "order_1" } }, payment: { entity: { id: "pay_x", order_id: "order_1" } } } };
    expect((await signed("/v1/hooks/razorpay", hook, () => ({ "x-razorpay-signature": "nope" }))).statusCode).toBe(401);
    expect((await signed("/v1/hooks/razorpay", hook, (raw) => ({ "x-razorpay-signature": hmacSha256("rzp_whsec", raw) }))).statusCode).toBe(200);
    expect((await api.get("/v1/billing")).body.creditsTotal).toBe(before + 50000);
    // Manual top-ups are disabled once a provider is configured.
    expect((await api.post("/v1/billing/topup", { credits: 5000 })).status).toBe(400);
  });

  it("Stripe: Checkout session → signed webhook grants credits", async () => {
    let form = "";
    mock.get("https://api.stripe.com").intercept({ path: "/v1/checkout/sessions", method: "POST" }).reply((o) => ((form = String(o.body)), { statusCode: 200, data: { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }, responseOptions: json }));
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const before = (await api.get("/v1/billing")).body.creditsTotal;
    const co = await api.post("/v1/billing/checkout", { credits: 10000, provider: "stripe" });
    expect(co.body).toMatchObject({ provider: "stripe", url: "https://checkout.stripe.com/c/cs_1", amount: 118000 });
    expect(decodeURIComponent(form)).toContain("line_items[0][price_data][unit_amount]=118000");
    expect((await api.get("/v1/billing/payments")).body.data[0]).toMatchObject({ provider: "stripe", credits: 10000, status: "created" });

    const event = { type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid" } } };
    const t = Math.floor(Date.now() / 1000);
    expect((await signed("/v1/hooks/stripe", event, () => ({ "stripe-signature": `t=${t},v1=deadbeef` }))).statusCode).toBe(401);
    const sig = (raw: string) => ({ "stripe-signature": `t=${t},v1=${hmacSha256("whsec_stripe", `${t}.${raw}`)}` });
    expect((await signed("/v1/hooks/stripe", event, sig)).statusCode).toBe(200);
    expect((await signed("/v1/hooks/stripe", event, sig)).statusCode).toBe(200);
    expect((await api.get("/v1/billing")).body.creditsTotal).toBe(before + 10000);
    expect((await api.get("/v1/audit")).body.data.some((a: any) => a.action === "billing.topup")).toBe(true);
  });
});

describe("single sign-on", () => {
  it("signs in with Google: verifies the ID token, creates the account and accepts invites", async () => {
    process.env.GOOGLE_CLIENT_ID = "gid";
    process.env.GOOGLE_CLIENT_SECRET = "gsecret";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    mock.get("https://www.googleapis.com").intercept({ path: "/oauth2/v3/certs", method: "GET" }).reply(200, { keys: [jwk] }, json).persist();

    // An admin invites the person first.
    const owner = await signup(ctx.app);
    const inv = await client(ctx.app, owner).post("/v1/members", { name: "Neha", email: "neha.sso@acme.in", role: "builder" });
    expect(inv.status).toBe(201);

    expect((await ctx.app.inject({ method: "GET", url: "/v1/auth/sso/providers" })).json()).toMatchObject({ google: true });
    const start = await ctx.app.inject({ method: "GET", url: "/v1/auth/sso/google/start?redirect=/workers" });
    const auth = new URL(String(start.headers.location));
    expect(auth.searchParams.get("scope")).toBe("openid email profile");
    const nonce = auth.searchParams.get("nonce")!;
    const state = auth.searchParams.get("state")!;

    const idToken = (n: string, extra: Record<string, unknown> = {}) =>
      new SignJWT({ email: "neha.sso@acme.in", email_verified: true, name: "Neha Iyer", nonce: n, ...extra }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://accounts.google.com").setAudience("gid").setSubject("g-123").setIssuedAt().setExpirationTime("5m").sign(privateKey);

    mock.get("https://oauth2.googleapis.com").intercept({ path: "/token", method: "POST" }).reply(200, { id_token: await idToken("wrong-nonce") }, json);
    const replay = await ctx.app.inject({ method: "GET", url: `/v1/auth/sso/google/callback?code=c&state=${encodeURIComponent(state)}` });
    expect(replay.headers.location).toContain("sso_error=");

    mock.get("https://oauth2.googleapis.com").intercept({ path: "/token", method: "POST" }).reply(200, { id_token: await idToken(nonce) }, json);
    const cb = await ctx.app.inject({ method: "GET", url: `/v1/auth/sso/google/callback?code=c&state=${encodeURIComponent(state)}` });
    const loc = String(cb.headers.location);
    expect(loc.startsWith("http://web.test/auth/callback#")).toBe(true);
    const frag = new URLSearchParams(loc.split("#")[1]);
    expect(frag.get("redirect")).toBe("/workers");
    expect(frag.get("workspace_id")).toBe(owner.workspaceId);

    const me = await client(ctx.app, { token: frag.get("access_token")! }).get("/v1/me");
    expect(me.body.user).toMatchObject({ email: "neha.sso@acme.in", name: "Neha Iyer" });
    expect(me.body.workspaces[0]).toMatchObject({ id: owner.workspaceId, role: "builder" });
    const members = (await client(ctx.app, owner).get("/v1/members")).body.data;
    expect(members.find((m: any) => m.email === "neha.sso@acme.in")).toMatchObject({ status: "active", sso: true });
  });
});
