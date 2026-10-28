import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => ctx.app.close());

describe("auth", () => {
  it("signs up, logs in and returns /me", async () => {
    const s = await signup(ctx.app, { workspaceName: "Kesar" });
    const me = await client(ctx.app, s).get("/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.workspaces[0]).toMatchObject({ name: "Kesar", role: "owner" });

    const bad = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: s.email, password: "nope-nope-nope" } });
    expect(bad.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: s.email.toUpperCase(), password: "correct-horse-battery" } });
    expect(ok.statusCode).toBe(200);
  });

  it("rejects duplicate signups and weak passwords", async () => {
    const s = await signup(ctx.app);
    const dup = await ctx.app.inject({ method: "POST", url: "/v1/auth/signup", payload: { name: "X", email: s.email, password: "another-long-password", workspaceName: "W" } });
    expect(dup.statusCode).toBe(409);
    const weak = await ctx.app.inject({ method: "POST", url: "/v1/auth/signup", payload: { name: "X", email: "weak@acme.in", password: "short", workspaceName: "W" } });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe("validation_error");
  });

  it("rotates refresh tokens and detects reuse", async () => {
    const s = await signup(ctx.app);
    const r1 = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const next = r1.json().refreshToken;
    const reuse = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(reuse.statusCode).toBe(401);
    // Reuse revokes the whole family, including the newly issued token.
    const after = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: next } });
    expect(after.statusCode).toBe(401);
  });

  it("rate-limits auth endpoints with a 429", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "nobody@acme.in", password: "x" }, remoteAddress: "10.9.9.9" })).statusCode;
    expect(last).toBe(429);
  });

  it("requires auth", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/v1/threads" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/v1/threads", headers: { authorization: "Bearer garbage" } })).statusCode).toBe(401);
  });
});

describe("members, invites and RBAC", () => {
  it("invites a member who joins with limited permissions", async () => {
    const owner = await signup(ctx.app);
    const api = client(ctx.app, owner);
    const inv = await api.post("/v1/members", { name: "Neha", email: "neha@acme.in", role: "member" });
    expect(inv.status).toBe(201);
    const token = inv.body.inviteLink.split("/invite/")[1];

    const info = await ctx.app.inject({ method: "GET", url: `/v1/auth/invites/${token}` });
    expect(info.json()).toMatchObject({ email: "neha@acme.in", role: "member", hasAccount: false });

    const join = await ctx.app.inject({ method: "POST", url: "/v1/auth/accept-invite", payload: { token, password: "neha-password-123" } });
    expect(join.statusCode).toBe(200);
    const member = client(ctx.app, { token: join.json().accessToken });

    expect((await member.get("/v1/threads")).status).toBe(200);
    expect((await member.post("/v1/policies", { name: "x", appliesTo: "*", effect: "deny" })).status).toBe(403);
    expect((await member.get("/v1/audit")).status).toBe(403);
    expect((await member.post("/v1/api-keys", { name: "k" })).status).toBe(403);

    // The invite can't be reused.
    expect((await ctx.app.inject({ method: "POST", url: "/v1/auth/accept-invite", payload: { token, password: "neha-password-123" } })).statusCode).toBe(400);

    const members = await api.get("/v1/members");
    expect(members.body.data.map((m: { email: string; status: string }) => [m.email, m.status])).toContainEqual(["neha@acme.in", "active"]);
  });

  it("keeps at least one owner", async () => {
    const owner = await signup(ctx.app);
    const api = client(ctx.app, owner);
    const me = (await api.get("/v1/members")).body.data[0];
    const res = await api.patch(`/v1/members/${me.id}`, { role: "admin" });
    expect(res.status).toBe(400);
  });

  it("isolates workspaces", async () => {
    const a = await signup(ctx.app);
    const b = await signup(ctx.app);
    const t = await client(ctx.app, a).post("/v1/threads", { title: "secret" });
    expect((await client(ctx.app, b).get(`/v1/threads/${t.body.id}`)).status).toBe(404);
    expect((await client(ctx.app, { token: b.token, workspaceId: a.workspaceId }).get("/v1/threads")).status).toBe(403);
  });
});
