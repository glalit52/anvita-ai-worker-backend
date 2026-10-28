import { lookup } from "node:dns/promises";
import postgres from "postgres";
import { config } from "../../config.js";
import { isPrivateAddress } from "../../lib/net.js";
import { ConnectorError, type Driver } from "../types.js";

const MAX_ROWS = 500;

/**
 * Read-only SQL against a customer database: a fresh single connection, a READ ONLY transaction
 * (Postgres rejects writes) and a statement timeout. Private addresses are refused in production
 * unless CONNECTOR_ALLOW_PRIVATE_HOSTS=1 (self-hosted deployments inside the customer's VPC).
 */
export async function pgQuery(dsn: string, sqlText: string, limit = MAX_ROWS) {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new ConnectorError("Invalid connection URL");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new ConnectorError("Use a postgres:// connection URL");
  if (config.NODE_ENV === "production" && process.env.CONNECTOR_ALLOW_PRIVATE_HOSTS !== "1") {
    const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new ConnectorError("The database host must be publicly reachable (or set CONNECTOR_ALLOW_PRIVATE_HOSTS on self-hosted deployments)");
  }
  const sql = postgres(dsn, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false, onnotice: () => {} });
  try {
    return await sql.begin("read only", async (tx) => {
      await tx.unsafe("set local statement_timeout = '15s'");
      const rows = await tx.unsafe(sqlText);
      return { rows: rows.slice(0, limit) as Record<string, unknown>[], count: rows.length, columns: rows.columns?.map((c) => c.name) ?? [] };
    });
  } catch (e) {
    throw new ConnectorError(`Database error: ${(e as Error).message}`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

function readOnly(q: string) {
  const s = q.trim().replace(/;+\s*$/, "");
  if (s.includes(";")) throw new ConnectorError("Run one statement at a time");
  if (!/^(select|with|explain|show|values|table)\b/i.test(s)) throw new ConnectorError("Only read-only queries (SELECT / WITH) are allowed");
  return s;
}

export const dataDrivers: Record<string, Driver> = {
  "postgres.query": async (i, { get }) => {
    const r = await pgQuery(get("dsn") ?? "", readOnly(String(i.sql ?? i.query ?? "")), Math.min(Number(i.limit ?? MAX_ROWS), MAX_ROWS));
    return { rows: r.rows, row_count: r.count, columns: r.columns, truncated: r.count > r.rows.length };
  },
  "bigquery.query": async (i, { call }) => {
    const r = await call<{ jobComplete: boolean; totalRows?: string; schema?: { fields: { name: string; type: string }[] }; rows?: { f: { v: unknown }[] }[]; errors?: { message: string }[] }>("https://bigquery.googleapis.com/bigquery/v2/projects/{project_id}/queries", {
      body: { query: readOnly(String(i.sql ?? i.query ?? "")), useLegacySql: false, maxResults: Math.min(Number(i.limit ?? MAX_ROWS), MAX_ROWS), timeoutMs: 30_000 },
    });
    if (!r.jobComplete) throw new ConnectorError("The query is still running — narrow it down or add a LIMIT");
    const fields = r.schema?.fields ?? [];
    const rows = (r.rows ?? []).map((row) => Object.fromEntries(row.f.map((c, idx) => [fields[idx]?.name ?? `col${idx}`, fields[idx]?.type && /INT|FLOAT|NUMERIC/.test(fields[idx].type) && c.v != null ? Number(c.v) : c.v])));
    return { rows, row_count: Number(r.totalRows ?? rows.length), columns: fields.map((f) => f.name) };
  },
};
