import { eq } from "drizzle-orm";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { approvals } from "../src/db/schema.js";
import { hmacSha256 } from "../src/lib/crypto.js";
import { newId } from "../src/lib/ids.js";
import { alertApprovers, decisionToken } from "../src/services/approval-alerts.js";
import { client, setup, signup, type Ctx, type Session } from "./helpers.js";

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

async function pendingApproval(s: Session) {
  const [a] = await db
    .insert(approvals)
    .values({ id: newId("apr"), workspaceId: s.workspaceId, title: "Send the weekly report to ravi@client.in", action: "gmail.send", appId: "gmail", requestedBy: { type: "worker", name: "Report Worker" }, onBehalfOf: "Test Owner", reason: "External email needs owner approval", risk: "medium", preview: { kind: "email", to: "ravi@client.in", subject: "Weekly ROAS" }, payload: {}, approverRole: "owner", expiresAt: new Date(Date.now() + 3600_000) })
    .returning();
  return a;
}
const statusOf = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0];

describe("approval alerts", () => {
  it("emails approvers one-click links that confirm before deciding", async () => {
    const s = await signup(ctx.app);
    const a = await pendingApproval(s);
    await alertApprovers(a.id);
    expect((await statusOf(a.id)).alerts).toEqual([{ kind: "email", to: s.email }]);

    const t = await decisionToken(a, s.userId, "approved");
    const page = await ctx.app.inject({ method: "GET", url: `/v1/approvals/respond?t=${t}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<form method=\"post\"");
    expect((await statusOf(a.id)).status).toBe("pending"); // GET never decides (mail scanners)

    expect((await ctx.app.inject({ method: "POST", url: "/v1/approvals/respond", payload: { t: `${t}x` } })).statusCode).toBe(400);
    const done = await ctx.app.inject({ method: "POST", url: "/v1/approvals/respond", payload: `t=${encodeURIComponent(t)}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain("Approved");
    expect(await statusOf(a.id)).toMatchObject({ status: "approved", decidedBy: "Test Owner" });
    const again = await ctx.app.inject({ method: "POST", url: "/v1/approvals/respond", payload: { t } });
    expect(again.statusCode).toBe(409);
    const audit = (await client(ctx.app, s).get("/v1/audit")).body.data;
    expect(audit.find((e: any) => e.action === "approval.approved")).toMatchObject({ channel: "Email" });
  });

  it("posts Slack cards with buttons, decides from a button press and updates the cards", async () => {
    const slack = mock.get("https://slack.com");
    slack.intercept({ path: "/api/auth.test", method: "POST" }).reply(200, { ok: true, team: "Kesar", team_id: "T777", user_id: "UBOT" }, json);
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.post("/v1/connections", { appId: "slack", credentials: { botToken: "xoxb-7" } });
    await api.patch("/v1/me", { approvalChannel: "slack" });
    await api.patch("/v1/workspace/settings", { "notify.approvalsSlackChannel": "C0APPROVALS" });

    const posted: any[] = [];
    slack.intercept({ path: /^\/api\/users\.lookupByEmail/, method: "GET" }).reply(200, { ok: true, user: { id: "U1" } }, json);
    slack.intercept({ path: "/api/chat.postMessage", method: "POST" }).reply((o) => {
      const b = JSON.parse(String(o.body));
      posted.push(b);
      return { statusCode: 200, data: { ok: true, channel: b.channel === "U1" ? "D1" : b.channel, ts: `${posted.length}.0` }, responseOptions: json };
    }).persist();
    const a = await pendingApproval(s);
    await alertApprovers(a.id);
    expect(posted.map((p) => p.channel)).toEqual(["C0APPROVALS", "U1"]);
    const actions = posted[0].blocks.find((b: any) => b.type === "actions");
    expect(actions.elements.map((e: any) => e.action_id)).toEqual(["approval.approve", "approval.reject", "approval.open"]);
    expect((await statusOf(a.id)).alerts).toEqual([{ kind: "slack", channel: "C0APPROVALS", ts: "1.0" }, { kind: "slack", channel: "D1", ts: "2.0" }]);

    // Button press: signed, mapped to the member by email.
    slack.intercept({ path: /^\/api\/users\.info/, method: "GET" }).reply(200, { ok: true, user: { profile: { email: s.email } } }, json);
    let ephemeral: any;
    mock.get("https://hooks.slack.com").intercept({ path: "/actions/T777/1/abc", method: "POST" }).reply((o) => ((ephemeral = JSON.parse(String(o.body))), { statusCode: 200, data: "ok" }));
    const payload = JSON.stringify({ type: "block_actions", team: { id: "T777" }, user: { id: "U1" }, actions: [{ action_id: "approval.approve", value: a.id }], response_url: "https://hooks.slack.com/actions/T777/1/abc" });
    const raw = `payload=${encodeURIComponent(payload)}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const press = (sig: string) => ctx.app.inject({ method: "POST", url: "/v1/hooks/slack/interactive", payload: raw, headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig } });
    expect((await press("v0=bad")).statusCode).toBe(401);
    expect((await press(`v0=${hmacSha256("test-slack-secret", `v0:${ts}:${raw}`)}`)).statusCode).toBe(200);
    expect(await statusOf(a.id)).toMatchObject({ status: "approved", decidedBy: "Test Owner" });
    expect(ephemeral.text).toContain("Approved");

    const updates: any[] = [];
    slack.intercept({ path: "/api/chat.update", method: "POST" }).reply((o) => (updates.push(JSON.parse(String(o.body))), { statusCode: 200, data: { ok: true }, responseOptions: json })).persist();
    await ctx.runner.drain();
    expect(updates.map((u) => u.channel).sort()).toEqual(["C0APPROVALS", "D1"]);
    expect(JSON.stringify(updates[0].blocks)).toContain("Approved by Test Owner");
    expect(updates[0].blocks.some((b: any) => b.type === "actions")).toBe(false);
  });

  it("sends WhatsApp reply buttons and decides from the reply", async () => {
    const graph = mock.get("https://graph.facebook.com");
    graph.intercept({ path: "/v21.0/777", method: "GET" }).reply(200, { display_phone_number: "+91 80000 00777" }, json);
    const sent: any[] = [];
    graph.intercept({ path: "/v21.0/777/messages", method: "POST" }).reply((o) => (sent.push(JSON.parse(String(o.body))), { statusCode: 200, data: { messages: [{ id: "wamid.x" }] }, responseOptions: json })).persist();
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.post("/v1/connections", { appId: "whatsapp", credentials: { access_token: "EAA", phone_number_id: "777", app_secret: "meta-777", verify_token: "v777" } });
    expect((await api.patch("/v1/me", { phone: "12" })).status).toBe(400);
    const me = await api.patch("/v1/me", { approvalChannel: "whatsapp", phone: "+91 98450 77777" });
    expect(me.body.phone).toBe("919845077777");

    const a = await pendingApproval(s);
    await alertApprovers(a.id);
    expect(sent[0]).toMatchObject({ to: "919845077777", type: "interactive" });
    expect(sent[0].interactive.action.buttons.map((b: any) => b.reply.id)).toEqual([`apr:${a.id}:approved`, `apr:${a.id}:rejected`]);

    const body = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "777" }, messages: [{ id: "wamid.in1", from: "919845077777", type: "interactive", interactive: { type: "button_reply", button_reply: { id: `apr:${a.id}:rejected`, title: "Reject" } } }] } }] }] });
    const res = await ctx.app.inject({ method: "POST", url: "/v1/hooks/whatsapp", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${hmacSha256("meta-777", body)}` } });
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();
    expect(await statusOf(a.id)).toMatchObject({ status: "rejected", decidedBy: "Test Owner" });
    expect(sent.at(-1).text.body).toContain("Rejected");
  });

  it("reports browser push as off without VAPID keys", async () => {
    const s = await signup(ctx.app);
    expect((await ctx.app.inject({ method: "GET", url: "/v1/push/key" })).json()).toEqual({ enabled: false, publicKey: null });
    expect((await client(ctx.app, s).post("/v1/me/push-subscriptions", { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" } })).status).toBe(400);
  });
});
