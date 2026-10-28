import { decrypt } from "../lib/crypto.js";
import { businessDrivers } from "./drivers/business.js";
import { googleDrivers } from "./drivers/google.js";
import { otherDrivers } from "./drivers/other.js";
import { dataDrivers } from "./drivers/data.js";
import { extraDrivers } from "./drivers/extra.js";
import { financeDrivers } from "./drivers/finance.js";
import { hrDrivers } from "./drivers/hr.js";
import { credentialGetter, makeCaller } from "./http.js";
import { connectorFor } from "./providers.js";
import type { Credentials, Driver } from "./types.js";

export const DRIVERS: Record<string, Driver> = { ...googleDrivers, ...businessDrivers, ...otherDrivers, ...extraDrivers, ...financeDrivers, ...hrDrivers, ...dataDrivers };

/** Parse stored credentials; legacy `{botToken}` blobs become API-key credentials. */
export function parseCredentials(enc: string | null | undefined): Credentials | null {
  if (!enc) return null;
  const raw = JSON.parse(decrypt(enc)) as Record<string, unknown>;
  if (raw.kind === "oauth" || raw.kind === "api_key") return raw as unknown as Credentials;
  return { kind: "api_key", fields: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)])) };
}

export function hasLiveDriver(action: string) {
  return action in DRIVERS;
}

/** Run an app action live. Callers decide whether to fall back to the demo driver. */
export async function runLive(appId: string, action: string, input: Record<string, unknown>, connection: { id: string | null; credentials: Credentials }) {
  const driver = DRIVERS[action];
  if (!driver) throw new Error(`No live driver for ${action}`);
  const call = makeCaller(appId, connection.id, connection.credentials);
  return driver(input, { call, creds: connection.credentials, get: credentialGetter(connection.credentials) });
}

/** Verify credentials with the app's cheapest authenticated call. */
export async function testConnection(appId: string, connection: { id: string | null; credentials: Credentials }): Promise<string> {
  const c = connectorFor(appId);
  if (!c?.test) return "Credentials saved (this app has no test call)";
  const r = await c.test(makeCaller(appId, connection.id, connection.credentials), credentialGetter(connection.credentials));
  if (typeof r === "string") return r;
  // Keep provider facts (e.g. Slack team id) on the credentials for routing inbound events.
  connection.credentials.extra = { ...(connection.credentials.extra ?? {}), ...r.extra };
  return r.detail;
}

export { connectorFor, oauthConfigured, CONNECTORS } from "./providers.js";
export type { Credentials } from "./types.js";
