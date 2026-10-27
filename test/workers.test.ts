import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacSha256 } from "../src/lib/crypto.js";
import { schedulerTick } from "../src/jobs/handlers.js";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => ctx.app.close());

describe("workers", () => {
  it("creates from a template, publishes, runs and versions", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    expect((await api.get("/v1/templates")).body.data.length).toBeGreaterThan(5);
    const w = await api.post("/v1/workers", { from: "template", templateId: "tpl-report" });
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ name: "Weekly Business Report", status: "draft", version: 0, createdFrom: "template", interaction: "scheduled" });
    expect(w.body.nodes.length).toBeGreaterThan(3);
    expect(w.body.schedule).toBe("30 3 * * MON"); // Monday 09:00 IST in UTC

    expect((await api.post(`/v1/workers/${w.body.id}/runs`, {})).status).toBe(400); // drafts must be published
    const pub = await api.post(`/v1/workers/${w.body.id}/publish`, { note: "first" });
    expect(pub.body).toMatchObject({ status: "live", version: 1 });

    for (const appId of ["metaads", "hubspot", "slack"]) await api.post("/v1/connections", { appId });
    const run = await api.post(`/v1/workers/${w.body.id}/runs`, { inputs: { range: "last_week" } });
    expect(run.status).toBe(202);
    await ctx.runner.drain();
    const done = (await api.get(`/v1/runs/${run.body.id}`)).body;
    expect(done).toMatchObject({ status: "succeeded", kind: "worker", workerVersion: 1 });
    expect(done.stepLog.length).toBeGreaterThan(0);

    const list = (await api.get("/v1/workers")).body.data.find((x: any) => x.id === w.body.id);
    expect(list.runs30d).toBe(1);
    expect(list.successRate).toBe(1);

    await api.patch(`/v1/workers/${w.body.id}`, { name: "Weekly Growth Report", nodes: [...w.body.nodes, { id: "extra", kind: "end", title: "Extra", x: 0, y: 0 }] });
    await api.post(`/v1/workers/${w.body.id}/publish`, {});
    const versions = (await api.get(`/v1/workers/${w.body.id}/versions`)).body.data;
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    const restored = await api.post(`/v1/workers/${w.body.id}/versions/1/restore`);
    expect(restored.body.nodes.length).toBe(w.body.nodes.length);

    const paused = await api.post(`/v1/workers/${w.body.id}/status`, { status: "paused" });
    expect(paused.body.status).toBe("paused");
    expect((await api.post(`/v1/workers/${w.body.id}/runs`, {})).status).toBe(409);

    const dup = await api.post(`/v1/workers/${w.body.id}/duplicate`);
    expect(dup.body).toMatchObject({ name: "Weekly Growth Report (copy)", status: "draft", version: 0 });
  });

  it("drafts with Autopilot and saves a chat as a Worker", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const draft = await api.post("/v1/workers/draft", { description: "Every Monday, pull Shopify orders and post a summary to Slack #ops" });
    expect(draft.body.interaction).toBe("scheduled");
    expect(draft.body.apps).toEqual(expect.arrayContaining(["shopify", "slack"]));

    await api.post("/v1/connections", { appId: "shopify" });
    const t = await api.post("/v1/threads", { text: "Weekly: summarise Shopify orders into a report" });
    await ctx.runner.drain();
    const saved = await api.post("/v1/workers", { from: "thread", threadId: t.body.id, name: "Weekly orders" });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ name: "Weekly orders", createdFrom: "run" });
    expect(saved.body.nodes.some((n: any) => n.appId === "shopify")).toBe(true);
    const th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    expect(th.messages[1].blocks.find((b: any) => b.type === "harden").status).toBe("saved");
  });

  it("fires schedules exactly once per minute", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const w = await api.post("/v1/workers", { from: "description", description: "Every day summarise Zendesk tickets", schedule: "*/5 * * * *" });
    await api.post(`/v1/workers/${w.body.id}/publish`, {});
    const at = new Date("2026-10-27T10:05:20Z");
    await schedulerTick(ctx.app.log, at);
    await schedulerTick(ctx.app.log, at); // second instance / duplicate tick
    await schedulerTick(ctx.app.log, new Date("2026-10-27T10:06:00Z")); // not due
    const runs = (await api.get(`/v1/workers/${w.body.id}/runs`)).body.data;
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toContain("Schedule");
  });

  it("manages eval cases and runs them", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const w = await api.post("/v1/workers", { from: "template", templateId: "tpl-support" });
    const put = await api.put(`/v1/workers/${w.body.id}/evals`, { cases: [{ input: "Where is my order?", expected: "Tracking link and ETA", category: "order_status" }] });
    expect(put.body.data).toHaveLength(1);
    expect((await api.post(`/v1/workers/${w.body.id}/evals/run`)).status).toBe(202);
    await ctx.runner.drain();
    const ev = (await api.get(`/v1/workers/${w.body.id}/evals`)).body;
    expect(ev.summary.total).toBe(1);
    expect(ev.data[0].score).toBeGreaterThan(0);
  });

  it("accepts signed webhook triggers only", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const w = await api.post("/v1/workers", { from: "description", description: "When an order webhook arrives, check Shopify and reply" });
    await api.post(`/v1/workers/${w.body.id}/publish`, {});
    const { webhookSecret, webhookUrl } = (await api.get(`/v1/workers/${w.body.id}`)).body;
    const body = JSON.stringify({ orderId: "KF-1" });
    const t = Math.floor(Date.now() / 1000);
    const bad = await ctx.app.inject({ method: "POST", url: webhookUrl, payload: body, headers: { "content-type": "application/json", "anvita-signature": `t=${t},v1=deadbeef` } });
    expect(bad.statusCode).toBe(401);
    const good = await ctx.app.inject({ method: "POST", url: webhookUrl, payload: body, headers: { "content-type": "application/json", "anvita-signature": `t=${t},v1=${hmacSha256(webhookSecret, `${t}.${body}`)}` } });
    expect(good.statusCode).toBe(202);
  });

  it("manages queue items and the human inbox", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const w = await api.post("/v1/workers", { from: "template", templateId: "tpl-invoice" });
    const q = await api.post(`/v1/workers/${w.body.id}/queue`, { ref: "INV-1", title: "Sharma Packaging", amount: "₹12,000", confidence: 0.82 });
    expect(q.status).toBe(201);
    expect((await api.patch(`/v1/queue/${q.body.id}`, { status: "done" })).body.status).toBe("done");

    const c = await api.post("/v1/inbox", { workerName: "Support", customer: "Meera", channel: "whatsapp", reason: "Damaged box" });
    expect((await api.post(`/v1/inbox/${c.body.id}/take`)).body.status).toBe("taken");
    expect((await api.post(`/v1/inbox/${c.body.id}/reply`, { text: "Sorry! Refund on the way." })).body.transcript).toHaveLength(1);
    expect((await api.post(`/v1/inbox/${c.body.id}/resolve`)).body.status).toBe("resolved");
  });
});

describe("developer platform", () => {
  it("issues scoped API keys that can be revoked", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const key = await api.post("/v1/api-keys", { name: "ERP", scope: "workers:run" });
    expect(key.status).toBe(201);
    expect(key.body.secret).toMatch(/^anv_live_/);
    expect((await api.get("/v1/api-keys")).body.data[0].secret).toBeUndefined();

    const viaKey = client(ctx.app, { token: key.body.secret });
    expect((await viaKey.get("/v1/workers")).status).toBe(200);
    expect((await viaKey.post("/v1/threads", { title: "x" })).status).toBe(403); // chat not in scope
    expect((await viaKey.post("/v1/policies", { name: "x", appliesTo: "*", effect: "deny" })).status).toBe(403);

    await api.del(`/v1/api-keys/${key.body.id}`);
    expect((await viaKey.get("/v1/workers")).status).toBe(401);
  });

  it("delivers signed outbound webhooks", async () => {
    const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    try {
      const s = await signup(ctx.app);
      const api = client(ctx.app, s);
      const hook = await api.post("/v1/webhooks", { url, events: ["run.completed"] });
      expect(hook.status).toBe(201);
      await api.post("/v1/threads", { text: "hi" });
      await ctx.runner.drain();
      expect(received).toHaveLength(1);
      const sig = String(received[0].headers["anvita-signature"]);
      const t = /t=(\d+)/.exec(sig)![1];
      expect(sig).toContain(`v1=${hmacSha256(hook.body.secret, `${t}.${received[0].body}`)}`);
      expect(JSON.parse(received[0].body)).toMatchObject({ type: "run.completed", data: { status: "succeeded" } });
      const deliveries = (await api.get(`/v1/webhooks/${hook.body.id}/deliveries`)).body.data;
      expect(deliveries[0]).toMatchObject({ status: "delivered", responseCode: 200 });
    } finally {
      server.close();
    }
  });

  it("exposes OpenAPI docs and health", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    const spec = await ctx.app.inject({ method: "GET", url: "/docs/json" });
    expect(spec.statusCode).toBe(200);
    expect(Object.keys(spec.json().paths)).toEqual(expect.arrayContaining(["/v1/threads", "/v1/workers/{id}/runs", "/v1/approvals/{id}/decision"]));
  });
});
