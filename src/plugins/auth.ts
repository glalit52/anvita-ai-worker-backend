import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { jwtVerify, SignJWT } from "jose";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { apiKeys, memberships, users, type Role } from "../db/schema.js";
import { sha256 } from "../lib/crypto.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { can, type Permission } from "../services/rbac.js";

export interface AuthContext {
  userId: string | null;
  userName: string;
  email: string | null;
  workspaceId: string;
  role: Role;
  /** Set when authenticated with an API key. */
  apiKeyId?: string;
  scopes?: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
  interface FastifyInstance {
    /** preHandler: requires an authenticated user/key bound to a workspace, optionally with a permission. */
    authorize: (perm?: Permission) => (req: FastifyRequest) => Promise<void>;
    /** preHandler: requires a signed-in user, workspace not required (e.g. /me, workspace creation). */
    authenticateUser: (req: FastifyRequest) => Promise<void>;
  }
}

const secret = new TextEncoder().encode(config.JWT_SECRET);

export async function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("anvita")
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

async function verifyAccessToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: "anvita", algorithms: ["HS256"] });
    if (payload.typ !== "access" || !payload.sub) throw new Error("bad token");
    return payload.sub;
  } catch {
    throw unauthorized("Invalid or expired access token");
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  // EventSource can't set headers; allow ?access_token= on SSE endpoints only.
  const q = (req.query as Record<string, unknown> | undefined)?.access_token;
  if (typeof q === "string" && req.url.includes("/stream")) return q;
  return null;
}

/** API key scopes are comma-separated; "all" grants everything a builder can do. */
const KEY_ROLE: Role = "builder";

async function resolve(req: FastifyRequest, requireWorkspace: boolean): Promise<AuthContext> {
  const token = bearer(req);
  if (!token) throw unauthorized();

  if (token.startsWith("anv_")) {
    const [key] = await db.select().from(apiKeys).where(and(eq(apiKeys.keyHash, sha256(token)), isNull(apiKeys.revokedAt))).limit(1);
    if (!key) throw unauthorized("Invalid API key");
    void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).catch(() => {});
    return { userId: null, userName: `API key · ${key.name}`, email: null, workspaceId: key.workspaceId, role: KEY_ROLE, apiKeyId: key.id, scopes: key.scope.split(",").map((s) => s.trim()) };
  }

  const userId = await verifyAccessToken(token);
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized("User no longer exists");

  const wanted = req.headers["x-workspace-id"];
  const where = typeof wanted === "string" && wanted
    ? and(eq(memberships.userId, userId), eq(memberships.workspaceId, wanted), eq(memberships.status, "active"))
    : and(eq(memberships.userId, userId), eq(memberships.status, "active"));
  const [m] = await db.select().from(memberships).where(where).orderBy(asc(memberships.createdAt)).limit(1);
  if (!m) {
    if (typeof wanted === "string" && wanted) throw forbidden("You are not a member of this workspace");
    if (requireWorkspace) throw forbidden("You don't belong to a workspace yet");
    return { userId, userName: user.name, email: user.email, workspaceId: "", role: "viewer" };
  }
  const now = new Date();
  if (!m.lastActiveAt || now.getTime() - m.lastActiveAt.getTime() > 60_000) {
    void db.update(memberships).set({ lastActiveAt: now }).where(eq(memberships.id, m.id)).catch(() => {});
    void db.update(users).set({ lastActiveAt: now }).where(eq(users.id, userId)).catch(() => {});
  }
  return { userId, userName: user.name, email: user.email, workspaceId: m.workspaceId, role: m.role };
}

/** API keys may only touch what their scope names. Scope strings: "all", "chat", "workers:run", "kb:read", "approvals". */
function keyAllows(scopes: string[], perm?: Permission): boolean {
  if (scopes.some((s) => s === "all" || s.startsWith("all"))) return true;
  if (!perm || perm === "workspace:read") return true;
  const map: Partial<Record<Permission, string[]>> = {
    "chat:write": ["chat"],
    "workers:run": ["workers:run", "workers"],
    "workers:write": ["workers"],
    "knowledge:write": ["kb:write", "kb"],
    "approvals:decide": ["approvals"],
  };
  return (map[perm] ?? []).some((need) => scopes.some((s) => s === need || s.startsWith(`${need}:`)));
}

export default fp(async (app: FastifyInstance) => {
  app.decorateRequest("auth", undefined);

  app.decorate("authorize", (perm?: Permission) => async (req: FastifyRequest) => {
    const ctx = await resolve(req, true);
    if (ctx.apiKeyId ? !keyAllows(ctx.scopes ?? [], perm) : perm && !can(ctx.role, perm)) {
      throw forbidden(perm ? `Requires permission ${perm}` : undefined);
    }
    req.auth = ctx;
  });

  app.decorate("authenticateUser", async (req: FastifyRequest) => {
    const ctx = await resolve(req, false);
    if (!ctx.userId) throw forbidden("This endpoint requires a user session");
    req.auth = ctx;
  });
});

export function auth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
