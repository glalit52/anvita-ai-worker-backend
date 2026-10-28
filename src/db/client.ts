import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;
/** A db handle or an open transaction — services accept either. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

export const sqlClient = postgres(config.DATABASE_URL, {
  max: config.DATABASE_POOL_MAX,
  onnotice: () => {},
  connection: { application_name: `anvita-${config.ROLE}` },
});

const baseDb: Db = drizzle(sqlClient, { schema });

// ─── Tenant isolation (row-level security) ─────────────────────────────────────

export const TENANT_ROLE = "anvita_tenant";
const tenantStorage = new AsyncLocalStorage<{ db: Db; active: boolean }>();
let rlsActive = false;

/** Turn RLS on when configured and the database has the tenant role (see migration 0009). */
export async function initTenantIsolation(log?: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void }): Promise<boolean> {
  if (!config.RLS_ENABLED) return (rlsActive = false);
  const [row] = await sqlClient<{ ok: boolean }[]>`select exists (select 1 from pg_roles where rolname = ${TENANT_ROLE}) and pg_has_role(current_user, ${TENANT_ROLE}, 'MEMBER') as ok`;
  rlsActive = !!row?.ok;
  if (rlsActive) log?.info({ role: TENANT_ROLE }, "row-level security on");
  else log?.warn({ role: TENANT_ROLE }, "row-level security unavailable: the tenant role is missing or not granted to the app user");
  return rlsActive;
}

export const tenantIsolationActive = () => rlsActive;

/**
 * Run `fn` in one transaction as the restricted tenant role with `app.workspace_id` set, so every
 * query — including ones that forget a workspace filter — only sees this workspace's rows.
 * Inside, `db` resolves to that transaction (nested `db.transaction` calls become savepoints).
 */
export async function withTenant<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  if (!rlsActive || !workspaceId) return fn();
  return baseDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    await tx.execute(sql.raw(`set local role ${TENANT_ROLE}`));
    const store = { db: tx as unknown as Db, active: true };
    try {
      return await tenantStorage.run(store, fn);
    } finally {
      // Work that outlives the request (timers, fire-and-forget) falls back to the pool.
      store.active = false;
    }
  });
}

/** Run `fn` outside any tenant scope (system work started from a request, e.g. job wake-ups). */
export function withoutTenant<T>(fn: () => T): T {
  return tenantStorage.exit(fn);
}

/** The app's db handle: the request's tenant transaction when one is active, otherwise the pool. */
export const db: Db = new Proxy(baseDb, {
  get(target, prop) {
    const store = tenantStorage.getStore();
    const d = store?.active ? store.db : target;
    const v = Reflect.get(d as object, prop, d);
    return typeof v === "function" ? v.bind(d) : v;
  },
});

export async function closeDb() {
  await sqlClient.end({ timeout: 5 });
}
