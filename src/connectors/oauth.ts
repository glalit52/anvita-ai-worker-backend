import { jwtVerify, SignJWT } from "jose";
import { config } from "../config.js";
import { connectorFor } from "./providers.js";
import { ConnectorError, type Credentials } from "./types.js";

/**
 * OAuth 2.0 authorization-code flow for connectors. The `state` is a short-lived signed token
 * carrying who is connecting what, so the public callback can't be forged or replayed into
 * another workspace.
 */

const secret = new TextEncoder().encode(config.JWT_SECRET);

export interface ConnectState {
  workspaceId: string;
  userId: string;
  userName: string;
  appId: string;
  scope: "workspace" | "user" | "shared";
  /** Web path to return to afterwards (e.g. the chat that asked for the connection). */
  returnTo: string;
  extra: Record<string, string>;
}

export const redirectUri = () => `${config.PUBLIC_URL}/v1/oauth/callback`;

function client(env: string) {
  const id = process.env[`${env}_CLIENT_ID`];
  const sec = process.env[`${env}_CLIENT_SECRET`];
  if (!id || !sec) throw new ConnectorError(`OAuth for this app isn't configured on the server (set ${env}_CLIENT_ID and ${env}_CLIENT_SECRET), or connect it with an API key.`);
  return { id, secret: sec };
}

export async function authorizeUrl(s: ConnectState): Promise<string> {
  const o = connectorFor(s.appId)?.oauth;
  if (!o) throw new ConnectorError(`${s.appId} doesn't support OAuth`);
  for (const f of o.needs ?? []) if (!s.extra[f.key] && !f.optional) throw new ConnectorError(`${f.label} is required`);
  const { id } = client(o.env);
  const state = await new SignJWT({ ...s, typ: "oauth_state" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("15m").sign(secret);
  const params = new URLSearchParams({ client_id: id, redirect_uri: redirectUri(), response_type: "code", state, ...(o.scopes.length ? { scope: o.scopes.join(o.scopeSeparator ?? " ") } : {}), ...(o.extraAuthParams ?? {}) });
  return `${o.authorizeUrl(s.extra)}?${params}`;
}

export async function readState(state: string): Promise<ConnectState> {
  try {
    const { payload } = await jwtVerify(state, secret, { algorithms: ["HS256"] });
    if (payload.typ !== "oauth_state") throw new Error("wrong token type");
    return payload as unknown as ConnectState;
  } catch {
    throw new ConnectorError("This connection link expired — start connecting again.");
  }
}

async function tokenRequest(appId: string, extra: Record<string, string>, params: Record<string, string>) {
  const o = connectorFor(appId)?.oauth;
  if (!o) throw new ConnectorError(`${appId} doesn't support OAuth`);
  const c = client(o.env);
  const headers: Record<string, string> = { Accept: "application/json" };
  const body: Record<string, string> = { ...params };
  if (o.tokenAuth === "basic") headers.Authorization = `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString("base64")}`;
  else Object.assign(body, { client_id: c.id, client_secret: c.secret });
  headers["Content-Type"] = o.tokenJson ? "application/json" : "application/x-www-form-urlencoded";
  const res = await fetch(o.tokenUrl(extra), { method: "POST", headers, body: o.tokenJson ? JSON.stringify(body) : new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20_000) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Slack returns 200 with ok:false on errors.
  if (!res.ok || data.ok === false || !data.access_token) throw new ConnectorError(`Token exchange failed: ${String(data.error_description ?? data.error ?? res.status)}`);
  return data;
}

export async function exchangeCode(s: ConnectState, code: string): Promise<Credentials> {
  const t = await tokenRequest(s.appId, s.extra, { grant_type: "authorization_code", code, redirect_uri: redirectUri() });
  const o = connectorFor(s.appId)!.oauth!;
  return {
    kind: "oauth",
    accessToken: String(t.access_token),
    refreshToken: t.refresh_token ? String(t.refresh_token) : undefined,
    expiresAt: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : undefined,
    scope: t.scope ? String(t.scope) : undefined,
    extra: { ...s.extra, ...(o.extract?.(t) ?? {}) },
  };
}

export async function refreshAccessToken(appId: string, creds: Credentials): Promise<Partial<Credentials>> {
  const t = await tokenRequest(appId, creds.extra ?? {}, { grant_type: "refresh_token", refresh_token: creds.refreshToken! });
  return {
    accessToken: String(t.access_token),
    refreshToken: t.refresh_token ? String(t.refresh_token) : creds.refreshToken,
    expiresAt: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : undefined,
  };
}
