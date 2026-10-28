import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
let mock: MockAgent;
let original: Dispatcher;

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
  mock.enableNetConnect(/127\.0\.0\.1|localhost/);
  setGlobalDispatcher(mock);
});

const json = { headers: { "content-type": "application/json" } };

describe("API-key connectors", () => {
  it("verifies credentials, stores them encrypted and reports the account", async () => {
    mock.get("https://kesar.myshopify.com").intercept({ path: "/admin/api/2025-10/shop.json", method: "GET", headers: { "x-shopify-access-token": "shpat_good" } }).reply(200, { shop: { name: "Kesar Foods" } }, json);
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const res = await api.post("/v1/connections", { appId: "shopify", credentials: { shop: "https://kesar.myshopify.com/", token: "shpat_good" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mode: "live", status: "healthy", statusDetail: "Shop Kesar Foods", hasCredentials: true });
    expect(JSON.stringify(res.body)).not.toContain("shpat_good");

    const apps = (await api.get("/v1/apps")).body.data;
    expect(apps.find((x: any) => x.id === "shopify")).toMatchObject({ mode: "live", auth: { apiKey: { fields: expect.any(Array) } } });
  });

  it("rejects credentials the app refuses and validates required fields", async () => {
    mock.get("https://api.stripe.com").intercept({ path: "/v1/account", method: "GET" }).reply(401, { error: { message: "Invalid API Key provided" } }, json);
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const bad = await api.post("/v1/connections", { appId: "stripe", credentials: { token: "sk_live_wrong" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain("Invalid API Key");
    expect((await api.post("/v1/connections", { appId: "shopify", credentials: { token: "x" } })).body.error.message).toContain("Shop domain is required");
    expect((await api.post("/v1/connections", { appId: "gmail", credentials: { token: "x" } })).body.error.message).toContain("OAuth");
  });

  it("runs agent tools against the live API and falls back to demo data without credentials", async () => {
    mock.get("https://kesar.myshopify.com").intercept({ path: "/admin/api/2025-10/shop.json", method: "GET" }).reply(200, { shop: { name: "Kesar" } }, json);
    mock
      .get("https://kesar.myshopify.com")
      .intercept({ path: (p) => p.startsWith("/admin/api/2025-10/orders.json"), method: "GET" })
      .reply(200, { orders: [
        { id: 1, name: "#1001", total_price: "1499.00", created_at: new Date().toISOString(), financial_status: "paid", fulfillment_status: null, cancelled_at: null, shipping_address: { province: "Tamil Nadu" }, line_items: [{ title: "Kaju Katli", quantity: 2 }], gateway: "Cash on Delivery (COD)" },
        { id: 2, name: "#1002", total_price: "999.00", created_at: new Date().toISOString(), financial_status: "paid", fulfillment_status: "fulfilled", cancelled_at: null, shipping_address: { province: "Karnataka" }, line_items: [{ title: "Soan Papdi", quantity: 1 }], gateway: "razorpay" },
      ] }, json);
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.post("/v1/connections", { appId: "shopify", credentials: { shop: "kesar.myshopify.com", token: "shpat_x" } });
    const t = await api.post("/v1/threads", { text: "How did our Shopify orders do this week?" });
    await ctx.runner.drain();
    const th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    const step = th.messages[1].blocks.find((b: any) => b.type === "steps").steps.find((x: any) => x.appId === "shopify");
    expect(step).toMatchObject({ status: "done", detail: "2 orders" });
    const run = (await api.get(`/v1/runs/${t.body.run.id}`)).body;
    expect(run.status).toBe("succeeded");

    // Another workspace without credentials gets labelled demo data.
    const s2 = await signup(ctx.app);
    const api2 = client(ctx.app, s2);
    await api2.post("/v1/connections", { appId: "shopify" });
    const t2 = await api2.post("/v1/threads", { text: "How did our Shopify orders do this week?" });
    await ctx.runner.drain();
    const th2 = (await api2.get(`/v1/threads/${t2.body.id}`)).body;
    expect(th2.messages[1].blocks.find((b: any) => b.type === "steps").steps.find((x: any) => x.appId === "shopify").detail).toContain("demo data");
  });
});

describe("OAuth connectors", () => {
  it("explains when OAuth isn't configured on the server", async () => {
    delete process.env.HUBSPOT_CLIENT_ID;
    const s = await signup(ctx.app);
    const res = await client(ctx.app, s).post("/v1/connections/hubspot/authorize", {});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("HUBSPOT_CLIENT_ID");
  });

  it("completes the code flow, refreshes expiring tokens and sends Gmail through an approval", async () => {
    process.env.GOOGLE_CLIENT_ID = "gid";
    process.env.GOOGLE_CLIENT_SECRET = "gsecret";
    const s = await signup(ctx.app, { domain: "acme.in" });
    const api = client(ctx.app, s);
    const start = await api.post("/v1/connections/gmail/authorize", { returnTo: "/chat/t-abc" });
    const url = new URL(start.body.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toContain("gmail.send");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const state = url.searchParams.get("state")!;

    let tokenBodies: string[] = [];
    // A 30-second token: the connection test right after the exchange already triggers a refresh.
    mock.get("https://oauth2.googleapis.com").intercept({ path: "/token", method: "POST" }).reply((opts) => {
      tokenBodies.push(String(opts.body));
      const refresh = String(opts.body).includes("grant_type=refresh_token");
      return { statusCode: 200, data: refresh ? { access_token: "ya29.refreshed", expires_in: 30 } : { access_token: "ya29.first", refresh_token: "1//refresh", expires_in: 30, scope: "gmail.send" }, responseOptions: json };
    }).times(2);
    mock.get("https://gmail.googleapis.com").intercept({ path: "/gmail/v1/users/me/profile", method: "GET" }).reply(200, { emailAddress: "owner@acme.in" }, json);

    const cb = await ctx.app.inject({ method: "GET", url: `/v1/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toMatch(/\/chat\/t-abc\?connected=gmail$/);
    expect(tokenBodies[0]).toContain("grant_type=authorization_code");
    expect(tokenBodies[0]).toContain("client_secret=gsecret");
    expect(tokenBodies[1]).toContain("refresh_token=1%2F%2Frefresh");
    const conn = (await api.get("/v1/connections")).body.data.find((c: any) => c.appId === "gmail");
    expect(conn).toMatchObject({ mode: "live", status: "healthy", statusDetail: "Connected as owner@acme.in" });

    // Forged / tampered state is rejected.
    const forged = await ctx.app.inject({ method: "GET", url: `/v1/oauth/callback?code=x&state=${encodeURIComponent(state.slice(0, -3) + "abc")}` });
    expect(forged.headers.location).toContain("connect_error=");

    // Token expires within a minute → refreshed before the send.
    tokenBodies = [];
    mock.get("https://oauth2.googleapis.com").intercept({ path: "/token", method: "POST" }).reply((opts) => {
      tokenBodies.push(String(opts.body));
      return { statusCode: 200, data: { access_token: "ya29.second", expires_in: 3600 }, responseOptions: json };
    });
    let sent: { auth?: string; raw?: string } = {};
    mock.get("https://gmail.googleapis.com").intercept({ path: "/gmail/v1/users/me/messages/send", method: "POST" }).reply((opts) => {
      sent = { auth: (opts.headers as Record<string, string>).Authorization ?? (opts.headers as Record<string, string>).authorization, raw: JSON.parse(String(opts.body)).raw };
      return { statusCode: 200, data: { id: "msg1", threadId: "th1" }, responseOptions: json };
    });
    await api.post("/v1/threads", { text: "Email the summary to partner@othercorp.com" });
    await ctx.runner.drain();
    const [appr] = (await api.get("/v1/approvals?status=pending")).body.data;
    await api.post(`/v1/approvals/${appr.id}/decision`, { decision: "approved" });
    await ctx.runner.drain();
    expect(tokenBodies[0]).toContain("grant_type=refresh_token");
    expect(sent.auth).toBe("Bearer ya29.second");
    const mime = Buffer.from(sent.raw!, "base64url").toString("utf8");
    expect(mime).toContain("To: partner@othercorp.com");
    expect(mime).toMatch(/Subject: /);
  });
});
