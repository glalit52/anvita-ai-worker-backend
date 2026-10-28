import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { memberships, refreshTokens, users, workspaces } from "../db/schema.js";
import { hashPassword, sha256, verifyPassword } from "../lib/crypto.js";
import { badRequest, conflict, forbidden, unauthorized } from "../lib/errors.js";
import { newId, randomString } from "../lib/ids.js";
import { auth, signAccessToken } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { serializeUser } from "../services/serializers.js";
import { createWorkspace } from "../services/workspace.js";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, "Use at least 10 characters").max(200);

async function issueTokens(userId: string, userAgent?: string) {
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
