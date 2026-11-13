import { and, asc, eq, gt } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { messages, threads } from "../db/schema.js";
import { randomString } from "../lib/ids.js";
import type { Endpoint } from "./endpoints.js";

/**
 * Website chat widget. Visitors get an anonymous session token (signed, per widget) on first
 * open; their conversation is a thread `widget:<endpoint>:<visitor>` answered by the widget's
 * Worker in customer mode. The widget polls for new messages (works behind any proxy/CDN).
 */

const secret = new TextEncoder().encode(`${config.JWT_SECRET}:widget-visitors`);

export async function visitorToken(e: Endpoint, visitorId = `v_${randomString(18)}`) {
  const token = await new SignJWT({ typ: "widget", ep: e.id }).setProtectedHeader({ alg: "HS256" }).setSubject(visitorId).setIssuedAt().setExpirationTime("30d").sign(secret);
  return { token, visitorId };
}

export async function readVisitor(e: Endpoint, header: string | undefined) {
  const token = header?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload.typ === "widget" && payload.ep === e.id && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Empty list = any site. Entries are origins ("https://shop.example.in") or bare hosts ("example.in" also matches subdomains). */
export function originAllowed(e: Endpoint, origin: string | undefined) {
  const allowed = ((e.config.allowedOrigins as string[] | undefined) ?? []).filter(Boolean);
  if (!allowed.length) return true;
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return allowed.some((a) => (a.includes("://") ? a.replace(/\/$/, "") === origin : host === a.toLowerCase() || host.endsWith(`.${a.toLowerCase()}`)));
}

export const widgetRef = (e: Endpoint, visitorId: string) => `widget:${e.id}:${visitorId}`;

const textOf = (blocks: unknown[]) =>
  (blocks as { type: string; text?: string }[])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!.trim())
    .join("\n\n");

/** Messages the visitor can see (text only), after an optional cursor. */
export async function visitorMessages(e: Endpoint, visitorId: string, after?: string) {
  const [t] = await db.select().from(threads).where(and(eq(threads.workspaceId, e.workspaceId), eq(threads.externalRef, widgetRef(e, visitorId))));
  if (!t) return { messages: [], busy: false };
  const conds = [eq(messages.threadId, t.id)];
  if (after) conds.push(gt(messages.createdAt, new Date(after)));
  const rows = await db.select().from(messages).where(and(...conds)).orderBy(asc(messages.createdAt)).limit(100);
  return {
    busy: t.status === "running",
    messages: rows
      .filter((m) => !m.streaming)
      .map((m) => ({ id: m.id, from: m.role === "user" ? "visitor" : "agent", author: m.role === "user" ? null : m.author, text: textOf(m.blocks), at: m.createdAt.toISOString() }))
      .filter((m) => m.text),
  };
}
