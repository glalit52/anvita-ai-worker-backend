import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => ctx.app.close());

const blocksOf = (thread: any) => thread.messages[1].blocks as any[];

describe("agent runs", () => {
  it("answers a simple question without tools", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const t = await api.post("/v1/threads", { text: "hello there" });
    expect(t.status).toBe(201);
    expect(t.body.run.status).toBe("queued");
    await ctx.runner.drain();
    const th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    expect(th.status).toBe("done");
    expect(blocksOf(th).some((b) => b.type === "text")).toBe(true);
    const run = (await api.get(`/v1/runs/${t.body.run.id}`)).body;
    expect(run.status).toBe("succeeded");
    expect(run.credits).toBeGreaterThan(0);
  });

  it("pauses for a connection and an approval, then resumes and completes", async () => {
    const s = await signup(ctx.app, { domain: "kesarfoods.in" });
    const api = client(ctx.app, s);
    const t = await api.post("/v1/threads", { text: "Get Meta ads ROAS for last week, build a PDF report and email it to investors@saffronvc.in" });
    await ctx.runner.drain();

    let th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    expect(th.status).toBe("waiting");
    expect(blocksOf(th).find((b) => b.type === "plan").steps.length).toBeGreaterThan(1);
    expect(blocksOf(th)).toContainEqual({ type: "connect", appId: "metaads", status: "pending" });
    expect((await api.get(`/v1/runs/${t.body.run.id}`)).body.status).toBe("waiting_auth");

    for (const appId of ["metaads", "gmail"]) {
      expect((await api.post("/v1/connections", { appId })).status).toBe(201);
      await ctx.runner.drain();
    }

    th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    expect((await api.get(`/v1/runs/${t.body.run.id}`)).body.status).toBe("waiting_approval");
    expect(blocksOf(th).some((b) => b.type === "artifact")).toBe(true);
    const approvalId = blocksOf(th).find((b) => b.type === "approval").approvalId;
    const appr = (await api.get(`/v1/approvals/${approvalId}`)).body;
    expect(appr).toMatchObject({ action: "gmail.send", status: "pending", approverRole: "owner" });
    expect(appr.reason).toContain("External email");

    // Approver edits the subject before approving.
    const dec = await api.post(`/v1/approvals/${approvalId}/decision`, { decision: "approved", payload: { subject: "Weekly ROAS (edited)" } });
    expect(dec.status).toBe(200);
    expect(dec.body.preview.subject).toBe("Weekly ROAS (edited)");
    expect((await api.post(`/v1/approvals/${approvalId}/decision`, { decision: "rejected" })).status).toBe(409);
    await ctx.runner.drain();

    th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    expect(th.status).toBe("done");
    const types = blocksOf(th).map((b) => b.type);
    expect(types).toEqual(expect.arrayContaining(["plan", "steps", "artifact", "approval", "text", "sources", "harden"]));
    expect(blocksOf(th).find((b) => b.type === "steps").steps.every((x: any) => x.status === "done")).toBe(true);
    expect(blocksOf(th).find((b) => b.type === "plan").actual).toBeGreaterThan(0);

    // Artifact is downloadable
    const art = blocksOf(th).find((b) => b.type === "artifact").artifact;
    const dl = await ctx.app.inject({ method: "GET", url: `/v1/artifacts/${art.id}/content`, headers: { authorization: `Bearer ${s.token}` } });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toContain("Report");

    // Billing, audit and notifications reflect the run
    const billing = (await api.get("/v1/billing")).body;
    expect(billing.creditsUsed).toBeGreaterThan(0);
    const auditRows = (await api.get("/v1/audit")).body.data.map((a: any) => a.action);
    expect(auditRows).toEqual(expect.arrayContaining(["approval.requested", "approval.approved", "gmail.send", "connection.created"]));
    expect((await api.get("/v1/audit/verify")).body).toMatchObject({ ok: true });
    expect((await api.get("/v1/notifications")).body.unread).toBeGreaterThan(0);
  });

  it("does not send when the approval is rejected", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.post("/v1/connections", { appId: "gmail" });
    const t = await api.post("/v1/threads", { text: "Draft a summary and email it to someone@outside.com" });
    await ctx.runner.drain();
    const pending = (await api.get("/v1/approvals?status=pending")).body.data;
    expect(pending).toHaveLength(1);
    await api.post(`/v1/approvals/${pending[0].id}/decision`, { decision: "rejected" });
    await ctx.runner.drain();
    const th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    const steps = blocksOf(th).find((b) => b.type === "steps").steps;
    expect(steps.find((x: any) => x.appId === "gmail").status).toBe("skipped");
    expect(blocksOf(th).filter((b) => b.type === "text").map((b) => b.text).join(" ")).toContain("didn't send");
    expect((await api.get("/v1/audit")).body.data.map((a: any) => a.action)).not.toContain("gmail.send");
  });

  it("enforces deny policies without asking", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.post("/v1/connections", { appId: "gmail" });
    const p = await api.post("/v1/policies", { name: "No email at all", appliesTo: "gmail.send", condition: "always", effect: "deny", priority: 1 });
    expect(p.status).toBe(201);
    expect((await api.post("/v1/policies", { name: "bad", appliesTo: "*", condition: "amount >", effect: "deny" })).status).toBe(400);

    const t = await api.post("/v1/threads", { text: "Email the summary to a@b.com" });
    await ctx.runner.drain();
    const th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    expect(th.status).toBe("done");
    expect(blocksOf(th).find((b) => b.type === "steps").steps.find((x: any) => x.appId === "gmail")).toMatchObject({ status: "error" });
    expect((await api.get("/v1/approvals?status=pending")).body.data).toHaveLength(0);

    const dry = await api.post("/v1/policies/evaluate", { action: "gmail.send", sideEffect: "external" });
    expect(dry.body.effect).toBe("deny");
  });

  it("only lets sufficiently senior roles approve", async () => {
    const owner = await signup(ctx.app);
    const api = client(ctx.app, owner);
    await api.post("/v1/connections", { appId: "gmail" });
    await api.post("/v1/threads", { text: "Email this to x@elsewhere.com" });
    await ctx.runner.drain();
    const [a] = (await api.get("/v1/approvals?status=pending")).body.data;
    const inv = await api.post("/v1/members", { name: "M", email: "m@acme.in", role: "member" });
    const join = await ctx.app.inject({ method: "POST", url: "/v1/auth/accept-invite", payload: { token: inv.body.inviteLink.split("/invite/")[1], password: "member-password-1" } });
    const member = client(ctx.app, { token: join.json().accessToken });
    expect((await member.post(`/v1/approvals/${a.id}/decision`, { decision: "approved" })).status).toBe(403);
  });

  it("cancels a waiting run", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const t = await api.post("/v1/threads", { text: "How did our Shopify orders do this week?" });
    await ctx.runner.drain();
    expect((await api.get(`/v1/runs/${t.body.run.id}`)).body.status).toBe("waiting_auth");
    expect((await api.post(`/v1/runs/${t.body.run.id}/cancel`)).body.status).toBe("cancelled");
    await api.post("/v1/connections", { appId: "shopify" });
    await ctx.runner.drain();
    expect((await api.get(`/v1/runs/${t.body.run.id}`)).body.status).toBe("cancelled");
  });

  it("uses the knowledge base and memory", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const kb = await api.post("/v1/knowledge-bases", { name: "Policies" });
    await api.post(`/v1/knowledge-bases/${kb.body.id}/documents`, { title: "Refund policy", content: "Refunds are allowed within 7 days of delivery for damaged items.\n\nShipping is free above ₹999." });
    const search = await api.post("/v1/knowledge/search", { query: "refund damaged" });
    expect(search.body.data[0].title).toBe("Refund policy");
    expect((await api.get(`/v1/knowledge-bases/${kb.body.id}`)).body).toMatchObject({ docs: 1, chunks: 1 });

    const t = await api.post("/v1/threads", { text: "What is our refund policy for damaged items?" });
    await ctx.runner.drain();
    const th = (await api.get(`/v1/threads/${t.body.id}`)).body;
    const kbStep = blocksOf(th).find((b) => b.type === "steps").steps.find((x: any) => x.kind === "kb");
    expect(kbStep.detail).toMatch(/passages/);
    expect(blocksOf(th).find((b) => b.type === "sources").sources[0].title).toBe("Refund policy");

    const mem = await api.post("/v1/memories", { content: "Reports go to #growth", type: "preference" });
    expect(mem.status).toBe(201);
    expect((await api.get("/v1/memories?q=growth")).body.data).toHaveLength(1);
  });

  it("refuses to start runs without credits", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const { db } = await import("../src/db/client.js");
    const { charge } = await import("../src/services/credits.js");
    await charge(s.workspaceId, 200000, { type: "test", id: "drain" }, undefined, db);
    const t = await api.post("/v1/threads", { title: "x" });
    const res = await api.post(`/v1/threads/${t.body.id}/messages`, { text: "hi" });
    expect(res.status).toBe(402);
  });

  it("uploads files and attaches them to a message", async () => {
    const s = await signup(ctx.app);
    const boundary = "----anvita";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sales.csv"\r\nContent-Type: text/csv\r\n\r\nday,orders\nmon,12\ntue,15\n\r\n--${boundary}--\r\n`;
    const up = await ctx.app.inject({ method: "POST", url: "/v1/files", payload: body, headers: { authorization: `Bearer ${s.token}`, "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode).toBe(201);
    const file = up.json().data[0];
    expect(file).toMatchObject({ kind: "sheet", title: "sales.csv" });
    const api = client(ctx.app, s);
    const t = await api.post("/v1/threads", { text: "Summarise the attached sheet", attachments: [file.id] });
    expect(t.status).toBe(201);
    expect(t.body.userMessage.blocks[1]).toMatchObject({ type: "artifact" });
    await ctx.runner.drain();
    expect((await api.get(`/v1/runs/${t.body.run.id}`)).body.status).toBe("succeeded");
  });
});
