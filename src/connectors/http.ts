import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections } from "../db/schema.js";
import { encrypt } from "../lib/crypto.js";
import { refreshAccessToken } from "./oauth.js";
import { connectorFor, host, zendeskSub } from "./providers.js";
import { ConnectorError, type Caller, type Credentials } from "./types.js";

/** Normalise user-entered values used inside URLs ({shop}, {site}, {subdomain}…). */
function urlValue(key: string, v: string): string {
  if (key === "subdomain") return zendeskSub(v);
  if (key === "ad_account_id") return v.replace(/^act_/, "");
  if (["shop", "site", "domain"].includes(key)) return host(v);
  return encodeURIComponent(v);
}

export function credentialGetter(c: Credentials) {
  return (key: string) => c.fields?.[key] ?? c.extra?.[key];
}

/**
 * Authenticated HTTP for one connection: fills `{placeholders}` from the connection, refreshes
 * expiring OAuth tokens (and persists them), retries 429/5xx with backoff, and turns provider
 * errors into readable messages.
 */
export function makeCaller(appId: string, connectionId: string | null, creds: Credentials): Caller {
  const conn = connectorFor(appId);
  if (!conn) throw new ConnectorError(`No live connector for ${appId}`);
  const get = credentialGetter(creds);

  const ensureFresh = async () => {
    if (creds.kind !== "oauth" || !creds.refreshToken || !creds.expiresAt || creds.expiresAt > Date.now() + 60_000) return;
    const next = await refreshAccessToken(appId, creds);
    Object.assign(creds, next);
    if (connectionId) await db.update(connections).set({ credentialsEnc: encrypt(JSON.stringify(creds)), status: "healthy" }).where(eq(connections.id, connectionId));
  };

  return async function call<T>(urlTemplate: string, init: Parameters<Caller>[1] = {}): Promise<T> {
    await ensureFresh();
    const url = urlTemplate.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = get(k);
      if (!v) throw new ConnectorError(`The ${appId} connection is missing “${k}”. Reconnect it in Integrations.`);
      return urlValue(k, v);
    });
    const headers: Record<string, string> = { Accept: "application/json", ...conn.headers(creds), ...(init.headers ?? {}) };
    let body: string | undefined;
    if (init.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    } else if (init.raw !== undefined) {
      body = init.raw;
    } else if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(20_000) });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
        continue;
      }
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        // non-JSON body
      }
      if (!res.ok) {
        if ((res.status === 401 || res.status === 403) && connectionId) await db.update(connections).set({ status: res.status === 401 ? "expired" : "error" }).where(eq(connections.id, connectionId));
        const d = data as { error?: { message?: string } | string; message?: string; errors?: unknown; error_description?: string };
        const msg = (typeof d?.error === "object" ? d.error?.message : undefined) ?? d?.error_description ?? d?.message ?? (typeof d?.error === "string" ? d.error : undefined) ?? (typeof data === "string" ? data.slice(0, 200) : JSON.stringify(d?.errors ?? data).slice(0, 200));
        throw new ConnectorError(`${appId} API error ${res.status}: ${msg}`, res.status);
      }
      return data as T;
    }
  };
}
