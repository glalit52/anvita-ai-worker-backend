import { and, eq } from "drizzle-orm";
import { appById } from "../catalog/index.js";
import { connectorFor, parseCredentials, testConnection, type Credentials } from "../connectors/index.js";
import { ConnectorError } from "../connectors/types.js";
import { db } from "../db/client.js";
import { connections } from "../db/schema.js";
import { encrypt } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { badRequest } from "../lib/errors.js";
import { resumeRunsWaitingForApp } from "../runtime/agent.js";
import { audit } from "./audit.js";
import { publish } from "./events.js";
import { serializeConnection } from "./serializers.js";

function accountLabel(appId: string, c: Credentials): string | null {
  const f = { ...(c.extra ?? {}), ...(c.fields ?? {}) };
  return f.teamName || f.shop || f.site || f.domain || f.subdomain || f.workspaceName || f.instanceUrl || f.ad_account_id || f.phone_number_id || f.email || f.key_id || (appId === "slack" ? f.teamId : null) || null;
}

/** Validate user-entered API-key fields against the app's spec. */
export function apiKeyCredentials(appId: string, fields: Record<string, string>): Credentials {
  const spec = connectorFor(appId)?.apiKey;
  if (!spec) throw badRequest(`${appById[appId]?.name ?? appId} connects with OAuth, not an API key`);
  const clean: Record<string, string> = {};
  for (const f of spec.fields) {
    const v = fields[f.key]?.trim();
    if (!v && !f.optional) throw badRequest(`${f.label} is required`);
    if (v) clean[f.key] = v;
  }
  return { kind: "api_key", fields: clean };
}

export interface SaveInput {
  workspaceId: string;
  appId: string;
  scope: "workspace" | "user" | "shared";
  userId: string | null;
  userName: string;
  sharedWith?: string[];
  credentials: Credentials | null;
  ip?: string;
}

/**
 * Create or replace a connection. With credentials it verifies them against the app first
 * (rejected credentials → 400; an unreachable app is saved as `error` so the user sees why).
 * Runs waiting on this app resume once it's healthy.
 */
export async function saveConnection(input: SaveInput) {
  // Re-connecting without credentials never downgrades a live connection to demo data.
  if (!input.credentials) {
    const [existing] = await db.select().from(connections).where(and(eq(connections.workspaceId, input.workspaceId), eq(connections.appId, input.appId)));
    if (existing?.mode === "live") {
      const [row] = await db.update(connections).set({ scope: input.scope, sharedWith: input.sharedWith ?? existing.sharedWith }).where(eq(connections.id, existing.id)).returning();
      await publish({ workspaceId: input.workspaceId, type: "connection.updated", data: serializeConnection(row) });
      if (row.status === "healthy") await resumeRunsWaitingForApp(input.workspaceId, input.appId);
      return row;
    }
  }
  let status: "healthy" | "error" = "healthy";
  let detail: string | null = input.credentials ? null : "Demo data — add credentials to use your real account";
  if (input.credentials) {
    try {
      detail = await testConnection(input.appId, { id: null, credentials: input.credentials });
    } catch (e) {
      const status401 = e instanceof ConnectorError && (e.status === 401 || e.status === 403);
      if (status401) throw badRequest(`${appById[input.appId]?.name ?? input.appId} rejected these credentials: ${(e as Error).message}`);
      status = "error";
      detail = (e as Error).message.slice(0, 300);
    }
  }
  const values = {
    scope: input.scope,
    ownerUserId: input.userId,
    connectedByName: input.userName,
    status,
    statusDetail: detail,
    sharedWith: input.sharedWith ?? [],
    mode: input.credentials ? ("live" as const) : ("demo" as const),
    account: input.credentials ? accountLabel(input.appId, input.credentials) : null,
    credentialsEnc: input.credentials ? encrypt(JSON.stringify(input.credentials)) : null,
  };
  const [row] = await db
    .insert(connections)
    .values({ id: newId("con"), workspaceId: input.workspaceId, appId: input.appId, ...values })
    .onConflictDoUpdate({ target: [connections.workspaceId, connections.appId], set: values })
    .returning();
  await audit({ workspaceId: input.workspaceId, actor: input.userName, actorId: input.userId, action: "connection.created", target: `${input.appId} (${input.scope}, ${values.mode})`, ip: input.ip });
  await publish({ workspaceId: input.workspaceId, type: "connection.updated", data: serializeConnection(row) });
  if (status === "healthy") await resumeRunsWaitingForApp(input.workspaceId, input.appId);
  return row;
}

export async function retestConnection(workspaceId: string, appId: string) {
  const [row] = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.appId, appId)));
  if (!row) return null;
  const creds = parseCredentials(row.credentialsEnc);
  if (!creds) return { row, ok: true, detail: "Using the demo connector (no credentials)" };
  let ok = true;
  let detail: string;
  try {
    detail = await testConnection(appId, { id: row.id, credentials: creds });
  } catch (e) {
    ok = false;
    detail = (e as Error).message.slice(0, 300);
  }
  const [u] = await db.update(connections).set({ status: ok ? "healthy" : (row.status === "expired" ? "expired" : "error"), statusDetail: detail }).where(eq(connections.id, row.id)).returning();
  await publish({ workspaceId, type: "connection.updated", data: serializeConnection(u) });
  if (ok) await resumeRunsWaitingForApp(workspaceId, appId);
  return { row: u, ok, detail };
}
