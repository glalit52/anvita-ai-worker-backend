import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { memberships, refreshTokens, users, workspaces } from "../db/schema.js";
import { hashPassword, sha256, verifyPassword } from "../lib/crypto.js";
import { AppError, badRequest, conflict, forbidden, unauthorized } from "../lib/errors.js";
import { samlLoginUrl, ssoForEmail } from "../services/saml.js";
import { newId, randomString } from "../lib/ids.js";
import { auth, signAccessToken } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { serializeUser } from "../services/serializers.js";
import { createWorkspace } from "../services/workspace.js";
import { ssoFinish, ssoProviders, ssoStartUrl } from "../services/sso.js";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, "Use at least 10 characters").max(200);

export async function issueTokens(userId: string, userAgent?: string) {
  const refresh = `rt_${randomString(48)}`;
  await db.insert(refreshTokens).values({ id: newId("rtk"), userId, tokenHash: sha256(refresh), userAgent: userAgent?.slice(0, 200) ?? null, expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86400_000) });
  return { accessToken: await signAccessToken(userId), refreshToken: refresh, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, tokenType: "Bearer" };
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
    const workspaceId = await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, email: em, name, passwordHash, lastActiveAt: new Date() });
      return createWorkspace(tx, { name: workspaceName, owner: { userId, name, email: em } });
    });
    return reply.status(201).send({ ...(await issueTokens(userId, req.headers["user-agent"])), ...(await meFor(userId)), workspaceId });
  });

  app.post("/auth/login", { ...loginLimit, schema: { tags, security: [], body: z.object({ email, password: z.string().min(1) }) } }, async (req) => {
    const [u] = await db.select().from(users).where(eq(users.email, req.body.email));
    if (!u || !(await verifyPassword(req.body.password, u.passwordHash))) throw unauthorized("Email or password is incorrect");
    // Organisations that enforce SAML don't allow password sign-in for their domains.
    const sso = await ssoForEmail(req.body.email);
    if (sso?.enforced) throw new AppError(403, "sso_required", "Your organisation requires single sign-on", { loginUrl: samlLoginUrl(sso.workspaceId) });
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, u.id));
    return { ...(await issueTokens(u.id, req.headers["user-agent"])), ...(await meFor(u.id)) };
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
    return issueTokens(rt.userId, req.headers["user-agent"]);
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
    const t = await issueTokens(u.id, req.headers["user-agent"]);
    const frag = new URLSearchParams({ access_token: t.accessToken, refresh_token: t.refreshToken, workspace_id: workspaceId ?? "", redirect: m ? id.redirect : "/onboarding" });
    return reply.redirect(`${config.WEB_URL}/auth/callback#${frag}`);
  });

  app.get("/me", { preHandler: app.authenticateUser, schema: { tags } }, async (req) => {
    const a = auth(req);
    return { ...(await meFor(a.userId!)), currentWorkspaceId: a.workspaceId || null, role: a.workspaceId ? a.role : null };
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
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, u.id), isNull(refreshTokens.revokedAt)));
    return reply.status(204).send();
  });

  /** Create an additional workspace (the caller becomes its owner). */
  app.post("/workspaces", { preHandler: app.authenticateUser, schema: { tags: ["workspace"], body: z.object({ name: z.string().trim().min(1).max(100) }) } }, async (req, reply) => {
    const a = auth(req);
    const id = await db.transaction((tx) => createWorkspace(tx, { name: req.body.name, owner: { userId: a.userId!, name: a.userName, email: a.email! } }));
    return reply.status(201).send({ id });
  });
};
