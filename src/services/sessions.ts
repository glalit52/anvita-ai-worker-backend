import { and, eq, gt, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { refreshTokens } from "../db/schema.js";
import { sha256 } from "../lib/crypto.js";
import { newId, randomString } from "../lib/ids.js";
import { signAccessToken } from "../plugins/auth.js";

export type Amr = "pwd" | "pwd+otp" | "sso";

/**
 * A sign-in creates a session; each refresh rotates its token but keeps the session id, the
 * original sign-in time and how it was authenticated — so workspace session limits and MFA
 * requirements apply to the whole session, and a session can be revoked as one.
 */
export async function issueTokens(userId: string, userAgent?: string, opts: { ip?: string; amr?: Amr; sessionId?: string; authTime?: Date } = {}) {
  const refresh = `rt_${randomString(48)}`;
  const sessionId = opts.sessionId ?? newId("ses");
  const authTime = opts.authTime ?? new Date();
  const amr = opts.amr ?? "pwd";
  await db.insert(refreshTokens).values({ id: newId("rtk"), userId, tokenHash: sha256(refresh), userAgent: userAgent?.slice(0, 200) ?? null, ip: opts.ip ?? null, sessionId, authTime, amr, expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86400_000) });
  forgetSession(sessionId);
  return { accessToken: await signAccessToken(userId, { sid: sessionId, authTime, amr }), refreshToken: refresh, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, tokenType: "Bearer" };
}

const live = new Map<string, { at: number; ok: boolean }>();
const forgetSession = (sid: string) => live.delete(sid);

/** Is the session still active (not signed out or revoked)? Cached briefly; checked on every request. */
export async function sessionActive(sid: string): Promise<boolean> {
  const hit = live.get(sid);
  if (hit && Date.now() - hit.at < 10_000) return hit.ok;
  const [row] = await db.select({ id: refreshTokens.id }).from(refreshTokens).where(and(eq(refreshTokens.sessionId, sid), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date()))).limit(1);
  live.set(sid, { at: Date.now(), ok: !!row });
  if (live.size > 10_000) live.clear();
  return !!row;
}

export async function revokeSession(userId: string, sid: string) {
  const rows = await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.sessionId, sid), isNull(refreshTokens.revokedAt))).returning({ id: refreshTokens.id });
  forgetSession(sid);
  return rows.length;
}

export async function revokeAllSessions(userId: string) {
  const rows = await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt))).returning({ sid: refreshTokens.sessionId });
  for (const r of rows) if (r.sid) forgetSession(r.sid);
  return rows.length;
}

/** A user's active sessions (latest token per session). */
export async function listSessions(userId: string) {
  const rows = await db.select().from(refreshTokens).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())));
  const bySession = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = r.sessionId ?? r.id;
    const cur = bySession.get(key);
    if (!cur || cur.createdAt < r.createdAt) bySession.set(key, r);
  }
  return [...bySession.entries()].map(([id, r]) => ({ id, userAgent: r.userAgent, ip: r.ip, method: r.amr, signedInAt: (r.authTime ?? r.createdAt).toISOString(), lastActiveAt: r.createdAt.toISOString() })).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}
