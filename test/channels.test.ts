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

function slackPost(body: object, secret = "test-slack-secret") {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return ctx.app.inject({ method: "POST", url: "/v1/hooks/slack/events", payload: raw, headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${hmacSha256(secret, `v0:${ts}:${raw}`)}` } });
}

describe("Slack", () => {
  it("verifies requests, answers mentions in the thread and drops duplicate deliveries", async () => {
    const slack = mock.get("https://slack.com");
    slack.intercept({ path: "/api/auth.test", method: "POST" }).reply(200, { ok: true, team: "Kesar", team_id: "T123", user_id: "UBOT" }, json);
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const conn = await api.post("/v1/connections", { appId: "slack", credentials: { botToken: "xoxb-1" } });
    expect(conn.body).toMatchObject({ mode: "live", account: "Kesar" });

    expect((await slackPost({ type: "url_verification", challenge: "abc" })).json()).toEqual({ challenge: "abc" });
    expect((await slackPost({ type: "url_verification", challenge: "abc" }, "wrong")).statusCode).toBe(401);

    slack.intercept({ path: /^\/api\/users\.info/, method: "GET" }).reply(200, { ok: true, user: { real_name: "Rahul Verma", profile: { email: "rahul@elsewhere.in" } } }, json);
    const posted: any[] = [];
    slack.intercept({ path: "/api/chat.postMessage", method: "POST" }).reply((o) => (posted.push(JSON.parse(String(o.body))), { statusCode: 200, data: { ok: true, ts: "9.9" }, responseOptions: json })).persist();

    const event = { type: "event_callback", team_id: "T123", event_id: "Ev1", event: { type: "app_mention", channel: "C42", user: "U1", text: "<@UBOT> hello there", ts: "1700000000.0001" } };
    expect((await slackPost(event)).statusCode).toBe(200);
    expect((await slackPost(event)).statusCode).toBe(200); // Slack retry
    await ctx.runner.drain();

    const threads = (await api.get("/v1/threads")).body.data;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ channel: "slack", status: "done" });
    const th = (await api.get(`/v1/threads/${threads[0].id}`)).body;
    expect(th.messages[0]).toMatchObject({ role: "user", author: "Rahul Verma" });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ channel: "C42", thread_ts: "1700000000.0001" });
    expect(posted[0].text).toContain("hello there");

    // A follow-up in the same Slack thread continues the same Anvita thread.
    await slackPost({ ...event, event_id: "Ev2", event: { ...event.event, ts: "1700000000.0002", thread_ts: "1700000000.0001", text: "<@UBOT> thanks" } });
    slack.intercept({ path: /^\/api\/users\.info/, method: "GET" }).reply(200, { ok: true, user: { real_name: "Rahul Verma" } }, json);
    await ctx.runner.drain();
    expect((await api.get("/v1/threads")).body.data).toHaveLength(1);
    expect(posted).toHaveLength(2);
  });
});

describe("WhatsApp", () => {
  it("routes customer messages to the bound Worker, replies, hands off and delivers human replies", async () => {
    const graph = mock.get("https://graph.facebook.com");
    graph.intercept({ path: "/v21.0/555", method: "GET" }).reply(200, { display_phone_number: "+91 98200 11223" }, json);
    const sent: any[] = [];
    graph.intercept({ path: "/v21.0/555/messages", method: "POST" }).reply((o) => (sent.push(JSON.parse(String(o.body))), { statusCode: 200, data: { messages: [{ id: "wamid.out" }] }, responseOptions: json })).persist();

    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const c = await api.post("/v1/connections", { appId: "whatsapp", credentials: { access_token: "EAA", phone_number_id: "555", app_secret: "meta-secret", verify_token: "verify-me" } });
    expect(c.body).toMatchObject({ mode: "live", statusDetail: "Number +91 98200 11223" });
    const w = await api.post("/v1/workers", { from: "template", templateId: "tpl-support", channels: ["WhatsApp +91 98200 11223"] });
    await api.post(`/v1/workers/${w.body.id}/publish`, {});

    const verify = await ctx.app.inject({ method: "GET", url: "/v1/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345" });
    expect(verify.body).toBe("12345");
    expect((await ctx.app.inject({ method: "GET", url: "/v1/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" })).statusCode).toBe(403);

    const inbound = (id: string, text: string, secret = "meta-secret") => {
      const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "555" }, contacts: [{ wa_id: "919841022221", profile: { name: "Meera" } }], messages: [{ id, from: "919841022221", type: "text", text: { body: text } }] } }] }] });
      return ctx.app.inject({ method: "POST", url: "/v1/hooks/whatsapp", payload: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${hmacSha256(secret, raw)}` } });
    };
    expect((await inbound("wamid.forged", "hi", "wrong")).statusCode).toBe(401);

    await inbound("wamid.1", "Hello, where is my order?");
    await ctx.runner.drain();
    const thread = (await api.get("/v1/threads")).body.data[0];
    expect(thread).toMatchObject({ channel: "whatsapp", workerId: w.body.id });
    expect(sent[0]).toMatchObject({ messaging_product: "whatsapp", to: "919841022221", type: "text" });
    const run = (await api.get(`/v1/runs?threadId=${thread.id}`)).body.data[0];
    expect(run).toMatchObject({ workerId: w.body.id, trigger: "WhatsApp", status: "succeeded" });

    // Customer asks for a person → handoff to the inbox, the Worker tells them a teammate will reply.
    await inbound("wamid.2", "This is useless, I want a human");
    await ctx.runner.drain();
    const [conv] = (await api.get("/v1/inbox")).body.data;
    expect(conv).toMatchObject({ customer: "Meera", phone: "+919841022221", status: "open", reason: "Customer asked for a person" });
    expect(sent.at(-1).text.body).toContain("teammate");

    // A teammate takes over: replies are delivered to WhatsApp, new customer messages go to the inbox, not the Worker.
    await api.post(`/v1/inbox/${conv.id}/take`);
    const before = sent.length;
    const reply = await api.post(`/v1/inbox/${conv.id}/reply`, { text: "Hi Meera, I'm Rahul — refunding now." });
    expect(reply.status).toBe(200);
    expect(sent[before].text.body).toBe("Hi Meera, I'm Rahul — refunding now.");
    const runsBefore = (await api.get(`/v1/runs?threadId=${thread.id}`)).body.data.length;
    await inbound("wamid.3", "Thank you!");
    await ctx.runner.drain();
    expect((await api.get(`/v1/runs?threadId=${thread.id}`)).body.data.length).toBe(runsBefore);
    expect((await api.get(`/v1/inbox/${conv.id}`)).body.transcript.at(-1)).toMatchObject({ from: "customer", text: "Thank you!" });
  });
});
