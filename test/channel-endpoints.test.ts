import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { threads } from "../src/db/schema.js";
import { stripReply } from "../src/channels/email.js";
import { twilioSignature } from "../src/channels/voice.js";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
let mock: MockAgent;
let original: Dispatcher;
const json = { headers: { "content-type": "application/json" } };
const PUBLIC = "http://localhost:4000"; // config default in tests

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

describe("website chat widget", () => {
  it("serves the script, checks the site, opens a visitor session and answers", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const ep = (await api.post("/v1/channel-endpoints", { kind: "widget", name: "Shop support", config: { allowedOrigins: ["shop.example.in"], color: "#0f766e" } })).body;
    expect(ep.key).toMatch(/^wgt_/);
    expect(ep.setup.embed).toContain(`data-anvita-widget="${ep.key}"`);

    const js = await ctx.app.inject({ method: "GET", url: "/widget.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");

    const call = (method: "GET" | "POST", path: string, origin: string, opts: { token?: string; payload?: unknown } = {}) => ctx.app.inject({ method, url: `/v1/public/widget/${ep.key}${path}`, payload: opts.payload as never, headers: { origin, ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
    const site = "https://www.shop.example.in";
    const conf = await call("GET", "", site);
    expect(conf.statusCode).toBe(200);
    expect(conf.headers["access-control-allow-origin"]).toBe(site);
    expect(conf.json()).toMatchObject({ title: "Shop support", color: "#0f766e" });
    expect((await call("GET", "", "https://evil.example.com")).statusCode).toBe(401);

    expect((await call("POST", "/messages", site, { payload: { text: "hi" } })).statusCode).toBe(401);
    const { token } = (await call("POST", "/session", site)).json();
    expect((await call("POST", "/messages", site, { token, payload: { text: "Where is my order 1042?" } })).statusCode).toBe(202);
    await ctx.runner.drain();
    const msgs = (await call("GET", "/messages", site, { token })).json();
    expect(msgs.busy).toBe(false);
    expect(msgs.messages[0]).toMatchObject({ from: "visitor", text: "Where is my order 1042?" });
    expect(msgs.messages.at(-1).from).toBe("agent");
    expect(msgs.messages.at(-1).text.length).toBeGreaterThan(0);
    const after = (await call("GET", `/messages?after=${encodeURIComponent(msgs.messages.at(-1).at)}`, site, { token })).json();
    expect(after.messages).toHaveLength(0);

    // Another visitor can't read this conversation; the team sees it as a widget thread.
    const other = (await call("POST", "/session", site)).json().token;
    expect((await call("GET", "/messages", site, { token: other })).json().messages).toHaveLength(0);
    const th = (await api.get("/v1/threads")).body.data.find((t: any) => t.channel === "widget");
    expect(th).toBeTruthy();

    // Disabled widgets stop answering.
    await api.patch(`/v1/channel-endpoints/${ep.id}`, { enabled: false });
    expect((await call("GET", "", site)).statusCode).toBe(404);
  });
});

describe("inbound email", () => {
  it("accepts provider webhooks with the secret, threads by sender and strips quoted replies", async () => {
    expect(stripReply("Thanks, that works.\n\nOn Mon, 3 Nov 2026 at 10:00, Anvita <support@acme.in> wrote:\n> old text")).toBe("Thanks, that works.");
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    expect((await api.post("/v1/channel-endpoints", { kind: "email", name: "Support inbox", config: {} })).status).toBe(400);
    const ep = (await api.post("/v1/channel-endpoints", { kind: "email", name: "Support inbox", config: { address: "support@acme.in" } })).body;
    const url = new URL(ep.setup.webhookUrl).pathname;
    expect(ep.secrets).toEqual({ webhook: true });

    const postmark = { From: "Meera Iyer <meera@customer.in>", FromFull: { Email: "meera@customer.in", Name: "Meera Iyer" }, Subject: "Refund for order 1042", TextBody: "Hi, I was charged twice for order 1042.\n\n> quoted", MessageID: "abc-1" };
    expect((await ctx.app.inject({ method: "POST", url: url.replace(/\/[^/]+$/, "/wrong"), payload: postmark })).statusCode).toBe(404);
    const r = await ctx.app.inject({ method: "POST", url, payload: postmark });
    expect(r.statusCode).toBe(200);
    expect(r.json().runId).toBeTruthy();
    await ctx.runner.drain();
    const [t] = await db.select().from(threads).where(eq(threads.id, r.json().threadId));
    expect(t).toMatchObject({ channel: "email", externalRef: `email:${ep.id}:meera@customer.in`, title: "Refund for order 1042" });

    // SendGrid-style form posts land in the same conversation.
    const again = await ctx.app.inject({ method: "POST", url, payload: "from=Meera%20%3Cmeera%40customer.in%3E&subject=Re%3A%20Refund&text=Any%20update%3F", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(again.json().threadId).toBe(t.id);
  });
});

describe("voice", () => {
  it("verifies Twilio signatures and runs a speech turn, holding the caller for slow answers", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    expect((await api.post("/v1/channel-endpoints", { kind: "voice", name: "Helpline", config: { provider: "twilio" } })).status).toBe(400);
    const ep = (await api.post("/v1/channel-endpoints", { kind: "voice", name: "Helpline", config: { provider: "twilio", number: "+918000000000" }, secrets: { authToken: "tw_token" } })).body;
    const post = (path: string, params: Record<string, string>, sig?: string) => {
      const body = new URLSearchParams(params).toString();
      return ctx.app.inject({ method: "POST", url: path, payload: body, headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig ?? twilioSignature("tw_token", `${PUBLIC}${path}`, params) } });
    };
    const base = `/v1/hooks/voice/${ep.key}`;
    expect((await post(`${base}/incoming`, { CallSid: "CA1", From: "+919800000001" }, "bad")).statusCode).toBe(401);
    const hello = await post(`${base}/incoming`, { CallSid: "CA1", From: "+919800000001" });
    expect(hello.headers["content-type"]).toContain("text/xml");
    expect(hello.body).toContain('<Gather input="speech"');
    expect(hello.body).toContain("Helpline");

    const turn = await post(`${base}/turn`, { CallSid: "CA1", From: "+919800000001", SpeechResult: "What are your opening hours?" });
    expect(turn.body).toContain("One moment");
    const wait = /<Redirect method="POST">([^<]+)<\/Redirect>/.exec(turn.body)![1].replace(/&amp;/g, "&");
    await ctx.runner.drain();
    const path = new URL(wait).pathname + new URL(wait).search;
    const answer = await post(path, { CallSid: "CA1", From: "+919800000001" });
    expect(answer.body).toMatch(/<Say language="en-IN">[^<]+<\/Say>/);
    expect(answer.body).toContain(`${base}/turn`);
    const [t] = (await api.get("/v1/threads")).body.data.filter((x: any) => x.channel === "voice");
    expect(t.title).toContain("+919800000001");
  });
});

describe("Microsoft Teams", () => {
  it("verifies the Bot Framework token, answers in the conversation", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", use: "sig", alg: "RS256" };
    mock.get("https://login.botframework.com").intercept({ path: "/v1/.well-known/keys", method: "GET" }).reply(200, { keys: [jwk] }, json).persist();
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    expect((await api.post("/v1/channel-endpoints", { kind: "teams", name: "Teams bot", config: { botAppId: "app-123" } })).status).toBe(400);
    const ep = (await api.post("/v1/channel-endpoints", { kind: "teams", name: "Teams bot", config: { botAppId: "app-123" }, secrets: { botPassword: "pw" } })).body;
    const serviceUrl = "https://smba.trafficmanager.net/in/";
    const activity = { type: "message", id: "1", text: "<at>Anvita</at> summarise yesterday's sales", serviceUrl, from: { id: "29:abc", name: "Priya" }, conversation: { id: "a:conv1", conversationType: "personal" }, recipient: { id: "28:app-123" } };
    const token = (aud: string) => new SignJWT({ serviceurl: serviceUrl }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://api.botframework.com").setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const send = async (aud: string) => ctx.app.inject({ method: "POST", url: `/v1/hooks/teams/${ep.key}`, payload: activity, headers: { authorization: `Bearer ${await token(aud)}` } });
    expect((await send("someone-else")).statusCode).toBe(401);
    expect((await send("app-123")).statusCode).toBe(200);

    mock.get("https://login.microsoftonline.com").intercept({ path: "/botframework.com/oauth2/v2.0/token", method: "POST" }).reply(200, { access_token: "bot-token", expires_in: 3600 }, json);
    const posted: any[] = [];
    mock.get("https://smba.trafficmanager.net").intercept({ path: "/in/v3/conversations/a%3Aconv1/activities", method: "POST" }).reply((o) => (posted.push({ auth: (o.headers as Record<string, string>).Authorization ?? (o.headers as Record<string, string>).authorization, body: JSON.parse(String(o.body)) }), { statusCode: 201, data: { id: "r1" }, responseOptions: json })).persist();
    await ctx.runner.drain();
    expect(posted.length).toBeGreaterThan(0);
    expect(posted[0].auth).toBe("Bearer bot-token");
    expect(posted[0].body).toMatchObject({ type: "message", textFormat: "markdown" });
    const t = (await api.get("/v1/threads")).body.data.find((x: any) => x.channel === "teams");
    expect(t.title).toBe("summarise yesterday's sales");
  });
});
