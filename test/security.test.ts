import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { threads } from "../src/db/schema.js";
import { applyRetention } from "../src/services/retention.js";
import { ipAllowed, redactText, totpCode, verifyTotp } from "../src/services/security.js";
import { eq } from "drizzle-orm";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => ctx.app.close());

const login = (email: string, password = "correct-horse-battery", remoteAddress = "10.1.2.3") => ctx.app.inject({ method: "POST", url: "/v1/auth/login", remoteAddress, payload: { email, password } });

describe("security primitives", () => {
  it("implements TOTP (RFC 6238 test vector), IP ranges and PII masking", () => {
    // RFC 6238 SHA-1 secret "12345678901234567890" in base32, T = 59s → 287082 (6 digits)
    expect(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
    expect(verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287082", 59_000 + 25_000)).toBe(true);
    expect(ipAllowed("10.0.5.9", ["10.0.0.0/16"])).toBe(true);
    expect(ipAllowed("10.1.5.9", ["10.0.0.0/16", "192.168.1.4"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(redactText("Call +91 98200 11223, PAN ABCDE1234F, Aadhaar 2345 6789 0123, card 4111 1111 1111 1111, a/c no 123456789012, order 1042")).toBe(
      "Call [phone], PAN [pan], Aadhaar [aadhaar], card [card], a/c no [account], order 1042",
    );
  });
});

describe("two-step verification and sessions", () => {
  it("enrols, requires the code at sign-in, enforces the workspace policy and revokes sessions", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);

    // The workspace can't require MFA until the admin has it.
    expect((await api.patch("/v1/workspace/settings", { "security.mfa": true })).status).toBe(400);

    const setup = (await api.post("/v1/me/mfa/setup")).body;
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Anvita/);
    expect((await api.post("/v1/me/mfa/enable", { code: "000000" })).status).toBe(400);
    const enabled = (await api.post("/v1/me/mfa/enable", { code: totpCode(setup.secret) })).body;
    expect(enabled.recoveryCodes).toHaveLength(8);
    const upgraded = client(ctx.app, { token: enabled.accessToken });
    expect((await upgraded.patch("/v1/workspace/settings", { "security.mfa": true })).status).toBe(200);

    // Old password-only session is now refused for workspace data; /me still works.
    const blocked = await api.get("/v1/threads");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("mfa_required");
    expect((await api.get("/v1/me")).body.security).toMatchObject({ mfaEnabled: true, mfaRequired: true });

    // Password sign-in now needs the second step; recovery codes work once.
    const first = (await login(s.email)).json();
    expect(first).toMatchObject({ mfaRequired: true });
    expect(first.accessToken).toBeUndefined();
    expect((await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa", payload: { mfaToken: first.mfaToken, code: "123456" } })).statusCode).toBe(401);
    const ok = (await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa", payload: { mfaToken: first.mfaToken, code: enabled.recoveryCodes[0] } })).json();
    expect(ok.accessToken).toBeTruthy();
    expect((await client(ctx.app, { token: ok.accessToken }).get("/v1/threads")).status).toBe(200);
    const again = (await login(s.email)).json();
    expect((await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa", payload: { mfaToken: again.mfaToken, code: enabled.recoveryCodes[0] } })).statusCode).toBe(401);

    // Sessions: list, then sign another device out — its token stops working immediately.
    const sessions = (await upgraded.get("/v1/me/sessions")).body.data;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((x: any) => x.current)).toHaveLength(1);
    const other = sessions.find((x: any) => !x.current && x.method === "pwd+otp");
    expect((await upgraded.del(`/v1/me/sessions/${other.id}`)).status).toBe(204);
    const dead = await client(ctx.app, { token: ok.accessToken }).get("/v1/threads");
    expect(dead.status).toBe(401);
    expect(dead.body.error.code).toBe("session_revoked");
    // Refresh keeps the session's method, so the policy still passes after refresh.
    const refreshed = (await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: enabled.refreshToken } })).json();
    expect((await client(ctx.app, { token: refreshed.accessToken }).get("/v1/threads")).status).toBe(200);
  });

  it("expires sessions older than the workspace limit", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    expect((await api.patch("/v1/workspace/settings", { "security.sessionHours": 0.0003 })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    const r = await api.get("/v1/threads");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("session_expired");
  });
});

describe("workspace policies", () => {
  it("enforces the IP allowlist without letting admins lock themselves out", async () => {
    const s = await signup(ctx.app);
    const call = (method: "GET" | "PATCH", url: string, ip: string, payload?: unknown) => ctx.app.inject({ method, url, remoteAddress: ip, payload: payload as never, headers: { authorization: `Bearer ${s.token}` } });
    expect((await call("PATCH", "/v1/workspace/settings", "203.0.113.7", { "security.ipRanges": "10.0.0.0/8, nonsense" })).statusCode).toBe(400);
    expect((await call("PATCH", "/v1/workspace/settings", "203.0.113.7", { "security.ipRanges": "10.0.0.0/8", "security.ipAllowlist": true })).json().error.message).toMatch(/lock yourself out/);
    expect((await call("PATCH", "/v1/workspace/settings", "203.0.113.7", { "security.ipRanges": "10.0.0.0/8, 203.0.113.0/24", "security.ipAllowlist": true })).statusCode).toBe(200);
    expect((await call("GET", "/v1/threads", "203.0.113.50")).statusCode).toBe(200);
    const blocked = await call("GET", "/v1/threads", "198.51.100.4");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("ip_not_allowed");
  });

  it("masks PII in the audit log when redaction is on", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.patch("/v1/workspace/settings", { "security.piiRedaction": true });
    await api.post("/v1/members", { name: "Ravi", email: "ravi98200@acme.in", role: "member" });
    await api.patch("/v1/workspace/settings", { "contact.note": "Call me on 9820011223" });
    const audit = (await api.get("/v1/audit")).body.data;
    expect(JSON.stringify(audit)).not.toMatch(/9820011223/);
  });

  it("captures sign-ups from the workspace's domain", async () => {
    const domain = `capture${Math.random().toString(36).slice(2, 7)}.in`;
    const owner = await signup(ctx.app, { domain });
    const api = client(ctx.app, owner);
    await api.patch("/v1/workspace", { domains: [domain] });
    await api.patch("/v1/workspace/settings", { "security.domainCapture": true });
    const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/signup", remoteAddress: "10.9.8.7", payload: { name: "New Hire", email: `hire@${domain}`, password: "correct-horse-battery", workspaceName: "Should not be created" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ workspaceId: owner.workspaceId, joinedExisting: true });
    const members = (await api.get("/v1/members")).body.data;
    expect(members.find((m: any) => m.email === `hire@${domain}`)).toMatchObject({ role: "member", status: "active" });
  });

  it("deletes content past the retention period but keeps the audit trail", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const t = (await api.post("/v1/threads", { title: "Old chat" })).body;
    await db.update(threads).set({ updatedAt: new Date(Date.now() - 40 * 86400_000) }).where(eq(threads.id, t.id));
    const fresh = (await api.post("/v1/threads", { title: "New chat" })).body;
    await api.patch("/v1/workspace/settings", { "security.retentionDays": 30 });
    const r = (await applyRetention()).find((x) => x.workspaceId === s.workspaceId);
    expect(r?.threads).toBe(1);
    expect((await api.get(`/v1/threads/${t.id}`)).status).toBe(404);
    expect((await api.get(`/v1/threads/${fresh.id}`)).status).toBe(200);
    expect((await api.get("/v1/audit")).body.data.some((e: any) => e.action === "data.retention")).toBe(true);
  });
});
