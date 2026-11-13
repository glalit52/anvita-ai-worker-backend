import { and, desc, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { channelEndpoints, workers } from "../db/schema.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { newId, randomString } from "../lib/ids.js";

export type Endpoint = typeof channelEndpoints.$inferSelect;
export type EndpointKind = Endpoint["kind"];

const KEY_PREFIX: Record<EndpointKind, string> = { widget: "wgt", email: "mbx", voice: "vce", teams: "tms" };

export function endpointSecrets(e: Endpoint): Record<string, string> {
  if (!e.secretEnc) return {};
  try {
    return JSON.parse(decrypt(e.secretEnc)) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function endpointByKey(key: string, kind: EndpointKind) {
  const [e] = await db.select().from(channelEndpoints).where(and(eq(channelEndpoints.key, key), eq(channelEndpoints.kind, kind)));
  return e && e.enabled ? e : null;
}

export async function endpointById(id: string) {
  const [e] = await db.select().from(channelEndpoints).where(eq(channelEndpoints.id, id));
  return e ?? null;
}

export async function createEndpoint(workspaceId: string, input: { kind: EndpointKind; name: string; workerId?: string | null; config?: Record<string, unknown>; secrets?: Record<string, string>; createdBy: string }) {
  const secrets = { ...(input.kind === "email" ? { webhook: randomString(32) } : {}), ...(input.secrets ?? {}) };
  const [row] = await db
    .insert(channelEndpoints)
    .values({ id: newId("chn"), workspaceId, kind: input.kind, name: input.name, workerId: input.workerId ?? null, key: `${KEY_PREFIX[input.kind]}_${randomString(24)}`, config: input.config ?? {}, secretEnc: Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null, createdBy: input.createdBy })
    .returning();
  return row;
}

export async function updateEndpoint(e: Endpoint, patch: { name?: string; workerId?: string | null; enabled?: boolean; config?: Record<string, unknown>; secrets?: Record<string, string> }) {
  const secrets = patch.secrets ? { ...endpointSecrets(e), ...patch.secrets } : null;
  const [row] = await db
    .update(channelEndpoints)
    .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.workerId !== undefined ? { workerId: patch.workerId } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(patch.config ? { config: { ...e.config, ...patch.config } } : {}), ...(secrets ? { secretEnc: encrypt(JSON.stringify(secrets)) } : {}) })
    .where(eq(channelEndpoints.id, e.id))
    .returning();
  return row;
}

export const listEndpoints = (workspaceId: string) => db.select().from(channelEndpoints).where(eq(channelEndpoints.workspaceId, workspaceId)).orderBy(desc(channelEndpoints.createdAt));

/** The Worker that answers on this endpoint, if it's still live. */
export async function endpointWorker(e: Endpoint) {
  if (!e.workerId) return null;
  const [w] = await db.select().from(workers).where(and(eq(workers.id, e.workerId), eq(workers.workspaceId, e.workspaceId)));
  return w ?? null;
}

/** What admins need to finish the setup on the provider side: embed code, webhook URLs. */
export function setupFor(e: Endpoint) {
  const api = `${config.PUBLIC_URL}/v1`;
  const s = endpointSecrets(e);
  switch (e.kind) {
    case "widget":
      return { embed: `<script src="${config.PUBLIC_URL}/widget.js" data-anvita-widget="${e.key}" async></script>` };
    case "email":
      return { webhookUrl: `${api}/hooks/email/${e.key}/${s.webhook ?? ""}`, note: "Point your provider's inbound-email webhook (Postmark, SendGrid Inbound Parse, Mailgun routes, or any JSON POST) at this URL." };
    case "voice":
      return { incomingUrl: `${api}/hooks/voice/${e.key}/incoming`, note: "Set this as the voice webhook (HTTP POST) of your phone number." };
    case "teams":
      return { messagingEndpoint: `${api}/hooks/teams/${e.key}`, note: "Use this as the messaging endpoint of your Azure Bot, then add the Teams channel." };
  }
}

export function serializeEndpoint(e: Endpoint) {
  const s = endpointSecrets(e);
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    workerId: e.workerId,
    key: e.key,
    enabled: e.enabled,
    config: e.config,
    secrets: Object.fromEntries(Object.keys(s).map((k) => [k, true])),
    setup: setupFor(e),
    createdAt: e.createdAt.toISOString(),
  };
}
