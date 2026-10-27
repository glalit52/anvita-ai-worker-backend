import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { sha256 } from "../lib/crypto.js";

export interface AuditInput {
  workspaceId: string;
  actor: string;
  actorId?: string | null;
  actorType?: "user" | "agent" | "worker" | "system";
  action: string;
  target: string;
  channel?: string;
  ip?: string | null;
  payload?: unknown;
}

/** Key-order-independent JSON (jsonb doesn't preserve key order, so hashes must not depend on it). */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

function digest(prevHash: string | null, e: { workspaceId: string; actor: string; actorType: string; action: string; target: string; channel: string; payload: unknown; createdAt: Date }) {
  return sha256(canonical([prevHash ?? "", e.workspaceId, e.actor, e.actorType, e.action, e.target, e.channel, e.payload ?? null, e.createdAt.toISOString()]));
}

/** Append to the workspace's hash-chained audit log. Serialized per workspace with an advisory lock. */
export async function audit(input: AuditInput, tx?: Tx): Promise<void> {
  const write = async (t: Tx) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${"audit:" + input.workspaceId}))`);
    const [prev] = await t.select({ hash: auditEvents.hash }).from(auditEvents).where(eq(auditEvents.workspaceId, input.workspaceId)).orderBy(desc(auditEvents.id)).limit(1);
    const row = {
      workspaceId: input.workspaceId,
      actor: input.actor,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? "user",
      action: input.action,
      target: input.target,
      channel: input.channel ?? "Web",
      ip: input.ip ?? null,
      payload: (input.payload ?? null) as object | null,
      createdAt: new Date(),
    };
    const prevHash = prev?.hash ?? null;
    await t.insert(auditEvents).values({ ...row, prevHash, hash: digest(prevHash, row) });
  };
  // Advisory xact locks need a transaction; reuse the caller's if it has one.
  if (tx && tx !== db) return write(tx);
  await db.transaction(write);
}

/** Recompute the chain; returns the first broken row id, if any. */
export async function verifyAuditChain(workspaceId: string): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
  const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.workspaceId, workspaceId))).orderBy(asc(auditEvents.id));
  let prev: string | null = null;
  for (const r of rows) {
    const expected = digest(prev, { ...r, payload: r.payload });
    if (r.prevHash !== prev || r.hash !== expected) return { ok: false, checked: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}
