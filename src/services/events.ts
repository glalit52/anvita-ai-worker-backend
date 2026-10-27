import { EventEmitter } from "node:events";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, sqlClient, type Tx } from "../db/client.js";
import { events } from "../db/schema.js";

export interface PublishInput {
  workspaceId: string;
  type: string;
  data: unknown;
  threadId?: string | null;
  runId?: string | null;
  /** Restrict delivery to one user (e.g. notifications). Omit to broadcast to the workspace. */
  userId?: string | null;
}

const CHANNEL = "anvita_events";
const local = new EventEmitter();
local.setMaxListeners(0);
let listening: Promise<unknown> | null = null;

/** Persist an event and fan it out to every API instance via Postgres NOTIFY. */
export async function publish(e: PublishInput, tx: Tx = db): Promise<number> {
  const [row] = await tx
    .insert(events)
    .values({ workspaceId: e.workspaceId, type: e.type, data: e.data as object, threadId: e.threadId ?? null, runId: e.runId ?? null, userId: e.userId ?? null })
    .returning({ id: events.id });
  await tx.execute(sql`select pg_notify(${CHANNEL}, ${`${e.workspaceId}:${row.id}`})`);
  return row.id;
}

/** Start the LISTEN connection once per process. */
export function ensureListening() {
  listening ??= sqlClient.listen(CHANNEL, (payload) => {
    const [workspaceId, id] = payload.split(":");
    local.emit(workspaceId, Number(id));
  });
  return listening;
}

export function onWorkspaceEvent(workspaceId: string, fn: (id: number) => void): () => void {
  void ensureListening();
  local.on(workspaceId, fn);
  return () => local.off(workspaceId, fn);
}

export interface EventFilter { workspaceId: string; userId: string; threadId?: string; runId?: string }

export async function fetchEventsAfter(f: EventFilter, afterId: number, limit = 200) {
  const conds = [eq(events.workspaceId, f.workspaceId), gt(events.id, afterId), or(isNull(events.userId), eq(events.userId, f.userId))];
  if (f.threadId) conds.push(eq(events.threadId, f.threadId));
  if (f.runId) conds.push(eq(events.runId, f.runId));
  return db.select().from(events).where(and(...conds)).orderBy(asc(events.id)).limit(limit);
}

export async function latestEventId(workspaceId: string): Promise<number> {
  const [row] = await db.select({ id: sql<number>`coalesce(max(${events.id}), 0)::bigint` }).from(events).where(eq(events.workspaceId, workspaceId));
  return Number(row?.id ?? 0);
}
