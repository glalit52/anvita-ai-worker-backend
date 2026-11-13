import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { memberships, refreshTokens, users, workspaces } from "../db/schema.js";
import { hashPassword, sha256, verifyPassword } from "../lib/crypto.js";
import { AppError, badRequest, conflict, forbidden, unauthorized } from "../lib/errors.js";
import { samlLoginUrl, ssoForEmail } from "../services/saml.js";
import { newId, randomString } from "../lib/ids.js";
import { auth } from "../plugins/auth.js";
import { SignJWT, jwtVerify } from "jose";
import { decrypt, encrypt } from "../lib/crypto.js";
import { isConsumerDomain, newRecoveryCodes, newTotpSecret, otpauthUrl, policyFrom, securityPolicy, verifyTotp } from "../services/security.js";
import { issueTokens, listSessions, revokeAllSessions, revokeSession, type Amr } from "../services/sessions.js";
import { audit } from "../services/audit.js";
import { serializeUser } from "../services/serializers.js";
import { createWorkspace } from "../services/workspace.js";
import { ssoFinish, ssoProviders, ssoStartUrl } from "../services/sso.js";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, "Use at least 10 characters").max(200);

export { issueTokens };

const mfaSecret = new TextEncoder().encode(`${config.JWT_SECRET}:mfa`);

/** Short-lived proof that the password was right, exchanged for tokens with a TOTP or recovery code. */
async function mfaChallenge(userId: string) {
  return new SignJWT({ typ: "mfa" }).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuedAt().setExpirationTime("5m").sign(mfaSecret);
}

/** A TOTP code, or a one-time recovery code (consumed). */
async function checkSecondFactor(u: typeof users.$inferSelect, code: string): Promise<boolean> {
  if (u.totpSecretEnc && verifyTotp(decrypt(u.totpSecretEnc), code)) return true;
  const h = sha256(code.trim().toLowerCase());
  if (u.recoveryCodes.includes(h)) {
    await db.update(users).set({ recoveryCodes: u.recoveryCodes.filter((x) => x !== h) }).where(eq(users.id, u.id));
    return true;
  }
  return false;
}

/** Domain capture: a workspace that turned it on and owns this email domain. */
async function capturingWorkspace(emailAddr: string) {
  const domain = emailAddr.split("@")[1]?.toLowerCase();
  if (!domain || isConsumerDomain(domain)) return null;
  const rows = await db.select({ id: workspaces.id, settings: workspaces.settings }).from(workspaces).where(sql`${domain} = any(${workspaces.domains})`);
  for (const w of rows) {
    if (!policyFrom(w.settings as Record<string, unknown>).domainCapture) continue;
    // The domain must belong to one of the workspace's owners or admins.
    const [admin] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.workspaceId, w.id), eq(memberships.status, "active"), inArray(memberships.role, ["owner", "admin"]), sql`lower(${memberships.email}) like ${"%@" + domain}`)).limit(1);
    if (admin) return w.id;
  }
  return null;
}

async function meFor(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  const ms = await db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, plan: workspaces.plan, region: workspaces.region, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")));
  return { user: serializeUser(u), workspaces: ms };
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ["auth"];
  const loginLimit = { config: { rateLimit: { max: config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } };

  app.post("/auth/signup", { ...loginLimit, schema: { tags, security: [], body: z.object({ name: z.string().trim().min(1).max(100), email, password, workspaceName: z.string().trim().min(1).max(100) }) } }, async (req, reply) => {
    if (!config.SIGNUP_ENABLED) throw forbidden("Sign-ups are disabled; ask an admin for an invite");
    const { name, email: em, password: pw, workspaceName } = req.body;
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, em));
    if (existing) throw conflict("An account with this email already exists");
    const userId = newId("usr");
    const passwordHash = await hashPassword(pw);
    const captured = await capturingWorkspace(em);
    const workspaceId = await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, email: em, name, passwordHash, lastActiveAt: new Date() });
      if (captured) {
        await tx.insert(memberships).values({ id: newId("mem"), workspaceId: captured, userId, email: em, name, role: "member", status: "active", lastActiveAt: new Date() });
        return captured;
      }
      return createWorkspace(tx, { name: workspaceName, owner: { userId, name, email: em } });
    });
    if (captured) await audit({ workspaceId: captured, actor: name, actorId: userId, action: "member.joined", target: `${em} (domain capture)`, ip: req.ip });
    return reply.status(201).send({ ...(await issueTokens(userId, req.headers["user-agent"], { ip: req.ip })), ...(await meFor(userId)), workspaceId, joinedExisting: !!captured });
  });

  app.post("/auth/login", { ...loginLimit, schema: { tags, security: [], body: z.object({ email, password: z.string().min(1) }) } }, async (req) => {
    const [u] = await db.select().from(users).where(eq(users.email, req.body.email));
    if (!u || !(await verifyPassword(req.body.password, u.passwordHash))) throw unauthorized("Email or password is incorrect");
    // Organisations that enforce SAML don't allow password sign-in for their domains.
    const sso = await ssoForEmail(req.body.email);
    if (sso?.enforced) throw new AppError(403, "sso_required", "Your organisation requires single sign-on", { loginUrl: samlLoginUrl(sso.workspaceId) });
    if (u.mfaEnabled) return { mfaRequired: true, mfaToken: await mfaChallenge(u.id) };
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, u.id));
    return { ...(await issueTokens(u.id, req.headers["user-agent"], { ip: req.ip })), ...(await meFor(u.id)) };
  });

  /** Second step of sign-in for people with two-step verification on. */
  app.post("/auth/mfa", { ...loginLimit, schema: { tags, security: [], body: z.object({ mfaToken: z.string(), code: z.string().trim().min(6).max(20) }) } }, async (req) => {
    let userId: string;
    try {
      const { payload } = await jwtVerify(req.body.mfaToken, mfaSecret, { algorithms: ["HS256"] });
      if (payload.typ !== "mfa" || !payload.sub) throw new Error();
      userId = payload.sub;
    } catch {
      throw unauthorized("Sign-in took too long — enter your password again");
    }
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u?.mfaEnabled || !(await checkSecondFactor(u, req.body.code))) throw unauthorized("That code isn't right");
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, u.id));
    return { ...(await issueTokens(u.id, req.headers["user-agent"], { ip: req.ip, amr: "pwd+otp" })), ...(await meFor(u.id)) };
  });

  /** Rotating refresh tokens: each use revokes the old token and issues a new pair. */
  app.post("/auth/refresh", { ...loginLimit, schema: { tags, security: [], body: z.object({ refreshToken: z.string().min(10) }) } }, async (req) => {
    const hash = sha256(req.body.refreshToken);
    const [rt] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash));
    if (!rt) throw unauthorized("Invalid refresh token");
    if (rt.revokedAt) {
      // Reuse of a rotated token suggests theft: revoke every session for this user.
      await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, rt.userId), isNull(refreshTokens.revokedAt)));
      throw unauthorized("Refresh token was already used; please sign in again");
    }
    if (rt.expiresAt < new Date()) throw unauthorized("Session expired; please sign in again");
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, rt.id));
    // Same session: keeps its id, original sign-in time and method.
    return issueTokens(rt.userId, req.headers["user-agent"], { ip: req.ip, sessionId: rt.sessionId ?? undefined, authTime: rt.authTime ?? rt.createdAt, amr: rt.amr as Amr });
  });

  app.post("/auth/logout", { schema: { tags, security: [], body: z.object({ refreshToken: z.string() }) } }, async (req, reply) => {
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.tokenHash, sha256(req.body.refreshToken)), isNull(refreshTokens.revokedAt)));
    return reply.status(204).send();
  });

  app.get("/auth/invites/:token", { schema: { tags, security: [], params: z.object({ token: z.string() }) } }, async (req) => {
    const [m] = await db
      .select({ email: memberships.email, name: memberships.name, role: memberships.role, workspace: workspaces.name })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(and(eq(memberships.inviteTokenHash, sha256(req.params.token)), eq(memberships.status, "invited"), gt(memberships.createdAt, new Date(Date.now() - 14 * 86400_000))));
    if (!m) throw badRequest("This invite link is invalid or has expired");
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, m.email.toLowerCase()));
    return { ...m, hasAccount: !!u };
  });

  /** Accept an invite: creates the account if needed (password required), or attaches an existing one (password must match). */
  app.post("/auth/accept-invite", { ...loginLimit, schema: { tags, security: [], body: z.object({ token: z.string(), name: z.string().trim().min(1).max(100).optional(), password }) } }, async (req) => {
    const [m] = await db.select().from(memberships).where(and(eq(memberships.inviteTokenHash, sha256(req.body.token)), eq(memberships.status, "invited")));
    if (!m || m.createdAt < new Date(Date.now() - 14 * 86400_000)) throw badRequest("This invite link is invalid or has expired");
    const [existing] = await db.select().from(users).where(eq(users.email, m.email.toLowerCase()));
    let userId: string;
    if (existing) {
      if (!(await verifyPassword(req.body.password, existing.passwordHash))) throw unauthorized("An account with this email exists; enter its password to join");
      userId = existing.id;
    } else {
      userId = newId("usr");
      await db.insert(users).values({ id: userId, email: m.email.toLowerCase(), name: req.body.name ?? m.name, passwordHash: await hashPassword(req.body.password) });
    }
    await db.update(memberships).set({ userId, status: "active", inviteTokenHash: null, name: req.body.name ?? m.name, lastActiveAt: new Date() }).where(eq(memberships.id, m.id));
    await audit({ workspaceId: m.workspaceId, actor: req.body.name ?? m.name, actorId: userId, action: "member.joined", target: m.email, ip: req.ip });
    return { ...(await issueTokens(userId, req.headers["user-agent"])), ...(await meFor(userId)), workspaceId: m.workspaceId };
  });

  // ─── Single sign-on (Google, Microsoft) ───

  app.get("/auth/sso/providers", { schema: { tags, security: [] } }, async () => ssoProviders());

  app.get("/auth/sso/:provider/start", { ...loginLimit, schema: { tags, security: [], params: z.object({ provider: z.enum(["google", "microsoft"]) }), querystring: z.object({ redirect: z.string().max(300).default("/home") }) } }, async (req, reply) => {
    const redirect = req.query.redirect.startsWith("/") && !req.query.redirect.startsWith("//") ? req.query.redirect : "/home";
    return reply.redirect(await ssoStartUrl(req.params.provider, redirect));
  });

  /**
   * SSO callback: verify the ID token, then sign in the matching user — creating the account (and
   * a workspace) on first sign-in and activating pending invites for that email. Tokens go back
   * to the web app in the URL fragment so they never reach server logs.
   */
  app.get("/auth/sso/:provider/callback", { schema: { tags, security: [], hide: true, params: z.object({ provider: z.enum(["google", "microsoft"]) }), querystring: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() }) } }, async (req, reply) => {
    const fail = (msg: string) => reply.redirect(`${config.WEB_URL}/login?sso_error=${encodeURIComponent(msg.slice(0, 200))}`);
    if (req.query.error || !req.query.code || !req.query.state) return fail(req.query.error_description ?? req.query.error ?? "Sign-in was cancelled");
    let id;
    try {
      id = await ssoFinish(req.params.provider, req.query.code, req.query.state);
    } catch (e) {
      req.log.warn({ err: e }, "sso failed");
      return fail((e as Error).message);
    }
    let [u] = await db.select().from(users).where(eq(users.email, id.email));
    let workspaceId: string | null = null;
    if (!u) {
      if (!config.SIGNUP_ENABLED) {
        const [invited] = await db.select().from(memberships).where(and(eq(memberships.email, id.email), eq(memberships.status, "invited")));
        if (!invited) return fail("No Anvita account for this email — ask an admin for an invite");
      }
      const userId = newId("usr");
      [u] = await db.insert(users).values({ id: userId, email: id.email, name: id.name, lastActiveAt: new Date() }).returning();
    }
    // Pending invites for this (verified) email are accepted automatically.
    await db.update(memberships).set({ userId: u.id, status: "active", sso: true, inviteTokenHash: null, lastActiveAt: new Date() }).where(and(eq(memberships.email, id.email), eq(memberships.status, "invited")));
    const [m] = await db.select().from(memberships).where(and(eq(memberships.userId, u.id), eq(memberships.status, "active")));
    if (!m) {
      const domain = id.email.split("@")[1];
      const consumer = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.com"].includes(domain);
      workspaceId = await db.transaction((tx) => createWorkspace(tx, { name: consumer ? `${id.name.split(" ")[0]}'s workspace` : domain.split(".")[0].replace(/^./, (c) => c.toUpperCase()), owner: { userId: u.id, name: u.name, email: u.email } }));
    } else workspaceId = m.workspaceId;
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, u.id));
    const t = await issueTokens(u.id, req.headers["user-agent"], { ip: req.ip, amr: "sso" });
    const frag = new URLSearchParams({ access_token: t.accessToken, refresh_token: t.refreshToken, workspace_id: workspaceId ?? "", redirect: m ? id.redirect : "/onboarding" });
    return reply.redirect(`${config.WEB_URL}/auth/callback#${frag}`);
  });

  app.get("/me", { preHandler: app.authenticateUser, schema: { tags } }, async (req) => {
    const a = auth(req);
    const [u] = await db.select({ mfaEnabled: users.mfaEnabled, hasPassword: users.passwordHash }).from(users).where(eq(users.id, a.userId!));
    const policy = a.workspaceId ? await securityPolicy(a.workspaceId) : null;
    return { ...(await meFor(a.userId!)), currentWorkspaceId: a.workspaceId || null, role: a.workspaceId ? a.role : null, security: { mfaEnabled: !!u?.mfaEnabled, hasPassword: !!u?.hasPassword, sessionMethod: a.amr ?? null, mfaRequired: !!policy?.mfa && (a.amr ?? "pwd") === "pwd", ip: req.ip } };
  });

  // ─── Two-step verification ───

  app.post("/me/mfa/setup", { preHandler: app.authenticateUser, schema: { tags } }, async (req) => {
    const a = auth(req);
    const secret = newTotpSecret();
    await db.update(users).set({ totpPendingEnc: encrypt(secret) }).where(eq(users.id, a.userId!));
    return { secret, otpauthUrl: otpauthUrl(secret, a.email ?? a.userName) };
  });

  /** Confirm the authenticator works; returns recovery codes (shown once) and upgrades this session. */
  app.post("/me/mfa/enable", { preHandler: app.authenticateUser, schema: { tags, body: z.object({ code: z.string().trim() }) } }, async (req) => {
    const a = auth(req);
    const [u] = await db.select().from(users).where(eq(users.id, a.userId!));
    if (!u.totpPendingEnc) throw badRequest("Start the setup again");
    const secret = decrypt(u.totpPendingEnc);
    if (!verifyTotp(secret, req.body.code)) throw badRequest("That code isn't right — check your phone's clock and try again");
    const codes = newRecoveryCodes();
    await db.update(users).set({ mfaEnabled: true, totpSecretEnc: encrypt(secret), totpPendingEnc: null, recoveryCodes: codes.map((c) => sha256(c)) }).where(eq(users.id, u.id));
    if (a.workspaceId) await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "mfa.enabled", target: u.email, ip: req.ip });
    const tokens = a.sessionId ? await issueTokens(u.id, req.headers["user-agent"], { ip: req.ip, sessionId: a.sessionId, authTime: a.authTime, amr: a.amr === "sso" ? "sso" : "pwd+otp" }) : null;
    return { recoveryCodes: codes, ...(tokens ?? {}) };
  });

  app.post("/me/mfa/disable", { preHandler: app.authenticateUser, schema: { tags, body: z.object({ code: z.string().trim() }) } }, async (req, reply) => {
    const a = auth(req);
    const [u] = await db.select().from(users).where(eq(users.id, a.userId!));
    if (!u.mfaEnabled) return reply.status(204).send();
    if (!(await checkSecondFactor(u, req.body.code))) throw badRequest("That code isn't right");
    await db.update(users).set({ mfaEnabled: false, totpSecretEnc: null, recoveryCodes: [] }).where(eq(users.id, u.id));
    if (a.workspaceId) await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "mfa.disabled", target: u.email, ip: req.ip });
    return reply.status(204).send();
  });

  // ─── Sessions ───

  app.get("/me/sessions", { preHandler: app.authenticateUser, schema: { tags } }, async (req) => {
    const a = auth(req);
    return { data: (await listSessions(a.userId!)).map((s) => ({ ...s, current: s.id === a.sessionId })) };
  });

  app.delete("/me/sessions/:id", { preHandler: app.authenticateUser, schema: { tags, params: z.object({ id: z.string() }) } }, async (req, reply) => {
    const a = auth(req);
    if (!(await revokeSession(a.userId!, req.params.id))) throw badRequest("Session not found");
    return reply.status(204).send();
  });

  /** Sign out everywhere else. */
  app.post("/me/sessions/revoke-others", { preHandler: app.authenticateUser, schema: { tags } }, async (req) => {
    const a = auth(req);
    let n = 0;
    for (const s of await listSessions(a.userId!)) if (s.id !== a.sessionId) n += await revokeSession(a.userId!, s.id);
    return { revoked: n };
  });

  app.patch(
    "/me",
    {
      preHandler: app.authenticateUser,
      schema: {
        tags,
        body: z.object({
          name: z.string().trim().min(1).max(100).optional(),
          title: z.string().max(100).optional(),
          language: z.enum(["en", "hi"]).optional(),
          timezone: z.string().max(64).optional(),
          approvalChannel: z.enum(["slack", "whatsapp", "email"]).optional(),
          digest: z.enum(["daily", "weekly", "off"]).optional(),
          quietHours: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const a = auth(req);
      const [u] = await db.update(users).set(req.body).where(eq(users.id, a.userId!)).returning();
      if (req.body.name) await db.update(memberships).set({ name: req.body.name }).where(eq(memberships.userId, a.userId!));
      return serializeUser(u);
    },
  );

  app.post("/me/password", { preHandler: app.authenticateUser, schema: { tags, body: z.object({ currentPassword: z.string(), newPassword: password }) } }, async (req, reply) => {
    const a = auth(req);
    const [u] = await db.select().from(users).where(eq(users.id, a.userId!));
    if (!(await verifyPassword(req.body.currentPassword, u.passwordHash))) throw unauthorized("Current password is incorrect");
    await db.update(users).set({ passwordHash: await hashPassword(req.body.newPassword) }).where(eq(users.id, u.id));
    await revokeAllSessions(u.id);
    return reply.status(204).send();
  });

  /** Create an additional workspace (the caller becomes its owner). */
  app.post("/workspaces", { preHandler: app.authenticateUser, schema: { tags: ["workspace"], body: z.object({ name: z.string().trim().min(1).max(100) }) } }, async (req, reply) => {
    const a = auth(req);
    const id = await db.transaction((tx) => createWorkspace(tx, { name: req.body.name, owner: { userId: a.userId!, name: a.userName, email: a.email! } }));
    return reply.status(201).send({ id });
  });
};
