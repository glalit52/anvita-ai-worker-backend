import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config.js";
import { routeInbound } from "./common.js";
import { endpointById, endpointSecrets, endpointWorker, type Endpoint } from "./endpoints.js";

/**
 * Microsoft Teams through an Azure Bot (Bot Framework). Teams POSTs activities to the
 * endpoint's messaging URL with a Bot Framework JWT; we verify it, run the Worker (or Anvita)
 * in a thread per conversation, and post the answer back to the conversation.
 */

export interface TeamsActivity {
  type: string;
  id?: string;
  text?: string;
  serviceUrl: string;
  from: { id: string; name?: string; aadObjectId?: string };
  recipient?: { id: string; name?: string };
  conversation: { id: string; conversationType?: string; isGroup?: boolean };
  channelData?: { tenant?: { id?: string } };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
const keys = () => (jwks ??= createRemoteJWKSet(new URL(config.TEAMS_JWKS_URL)));

/** Only send to Microsoft's connector hosts (the URL comes from the request). */
export function validServiceUrl(u: string) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && /(^|\.)(botframework\.com|trafficmanager\.net|teams\.microsoft\.com|botframework\.azure\.us)$/.test(url.hostname);
  } catch {
    return false;
  }
}

export async function verifyTeamsRequest(e: Endpoint, authorization: string | undefined, activity: TeamsActivity) {
  const token = authorization?.replace(/^Bearer\s+/i, "");
  const appId = String(e.config.botAppId ?? "");
  if (!token || !appId) return false;
  try {
    const { payload } = await jwtVerify(token, keys(), { issuer: "https://api.botframework.com", audience: appId, clockTolerance: 300 });
    // The token is bound to the service URL it was issued for.
    if (payload.serviceurl && payload.serviceurl !== activity.serviceUrl) return false;
    const tenant = String(e.config.tenantId ?? "");
    if (tenant && activity.channelData?.tenant?.id && activity.channelData.tenant.id !== tenant) return false;
    return validServiceUrl(activity.serviceUrl);
  } catch {
    return false;
  }
}

/** Thread ref keeps what a reply needs: endpoint, service URL and conversation id. */
export const teamsRef = (e: Endpoint, a: TeamsActivity) => `teams:${Buffer.from(JSON.stringify({ e: e.id, s: a.serviceUrl, c: a.conversation.id })).toString("base64url")}`;
const parseRef = (ref: string) => JSON.parse(Buffer.from(ref.slice("teams:".length), "base64url").toString()) as { e: string; s: string; c: string };

export async function handleTeamsActivity(e: Endpoint, a: TeamsActivity) {
  if (a.type !== "message") return { ignored: a.type };
  const text = (a.text ?? "").replace(/<at>[^<]*<\/at>/g, "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
  if (!text) return { ignored: "empty" };
  const worker = await endpointWorker(e);
  const r = await routeInbound({ workspaceId: e.workspaceId, ref: teamsRef(e, a), title: text, channel: "teams", channelLabel: a.conversation.conversationType === "personal" ? "Teams chat" : "Teams", workerId: worker?.id, author: a.from.name ?? "Teams user", text, trigger: "Teams", customer: e.config.customerFacing === true });
  return { threadId: r.thread.id, runId: r.run?.id ?? null };
}

const tokenCache = new Map<string, { token: string; exp: number }>();

async function botToken(e: Endpoint) {
  const hit = tokenCache.get(e.id);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const appId = String(e.config.botAppId ?? "");
  const password = endpointSecrets(e).botPassword;
  if (!appId || !password) throw new Error("Teams bot app id / password missing");
  const tenant = String(e.config.tenantId ?? "") || "botframework.com";
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: appId, client_secret: password, scope: "https://api.botframework.com/.default" }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(`Teams token: ${j.error_description ?? res.status}`);
  tokenCache.set(e.id, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

export async function sendTeams(ref: string, markdown: string) {
  const { e: endpointId, s: serviceUrl, c: conversationId } = parseRef(ref);
  const e = await endpointById(endpointId);
  if (!e) throw new Error("This Teams channel was removed");
  if (!validServiceUrl(serviceUrl)) throw new Error("Invalid Teams service URL");
  const res = await fetch(`${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await botToken(e)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "message", textFormat: "markdown", text: markdown.slice(0, 28_000) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Teams: ${res.status} ${await res.text().catch(() => "")}`.trim());
  return true;
}
