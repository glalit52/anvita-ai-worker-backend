import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { config } from "../config.js";
import { badRequest } from "../lib/errors.js";
import { randomString } from "../lib/ids.js";

/**
 * Sign-in with Google / Microsoft (OpenID Connect authorization-code flow). Uses the same OAuth
 * clients as the connectors (`GOOGLE_CLIENT_ID`… / `MICROSOFT_CLIENT_ID`…); register
 * `<PUBLIC_URL>/v1/auth/sso/<provider>/callback` as a redirect URI.
 */

export type SsoProvider = "google" | "microsoft";

const tenant = () => process.env.MICROSOFT_TENANT ?? "common";
const PROVIDERS = {
  google: { env: "GOOGLE", authorize: () => "https://accounts.google.com/o/oauth2/v2/auth", token: () => "https://oauth2.googleapis.com/token", jwks: "https://www.googleapis.com/oauth2/v3/certs", issuer: (iss: string) => iss === "https://accounts.google.com" || iss === "accounts.google.com" },
  microsoft: {
    env: "MICROSOFT",
    authorize: () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`,
    token: () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`,
    jwks: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    // Multi-tenant tokens carry the user's tenant in the issuer.
    issuer: (iss: string) => /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(iss),
  },
} as const;

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const secret = new TextEncoder().encode(config.JWT_SECRET);
const creds = (p: SsoProvider) => ({ id: process.env[`${PROVIDERS[p].env}_CLIENT_ID`], secret: process.env[`${PROVIDERS[p].env}_CLIENT_SECRET`] });

export const ssoProviders = () => ({ google: !!(creds("google").id && creds("google").secret), microsoft: !!(creds("microsoft").id && creds("microsoft").secret) });
export const ssoRedirectUri = (p: SsoProvider) => `${config.PUBLIC_URL}/v1/auth/sso/${p}/callback`;

export async function ssoStartUrl(p: SsoProvider, redirect: string) {
  const c = creds(p);
  if (!c.id || !c.secret) throw badRequest(`${p === "google" ? "Google" : "Microsoft"} sign-in isn't configured on this server`);
  const nonce = randomString(24);
  const state = await new SignJWT({ typ: "sso_state", p, nonce, redirect }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(secret);
  const params = new URLSearchParams({ client_id: c.id, redirect_uri: ssoRedirectUri(p), response_type: "code", scope: "openid email profile", state, nonce, prompt: "select_account" });
  return `${PROVIDERS[p].authorize()}?${params}`;
}

export interface SsoIdentity { email: string; name: string; provider: SsoProvider; redirect: string }

export async function ssoFinish(p: SsoProvider, code: string, state: string): Promise<SsoIdentity> {
  let st: { p: string; nonce: string; redirect: string };
  try {
    st = (await jwtVerify(state, secret, { algorithms: ["HS256"] })).payload as unknown as typeof st;
    if ((st as unknown as { typ: string }).typ !== "sso_state" || st.p !== p) throw new Error();
  } catch {
    throw badRequest("Sign-in link expired — please try again");
  }
  const c = creds(p);
  const res = await fetch(PROVIDERS[p].token(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: ssoRedirectUri(p), client_id: c.id!, client_secret: c.secret! }).toString(), signal: AbortSignal.timeout(15_000) });
  const t = (await res.json().catch(() => ({}))) as { id_token?: string; error_description?: string; error?: string };
  if (!res.ok || !t.id_token) throw badRequest(`Sign-in failed: ${t.error_description ?? t.error ?? res.status}`);
  if (!jwks.has(p)) jwks.set(p, createRemoteJWKSet(new URL(PROVIDERS[p].jwks)));
  const { payload } = await jwtVerify(t.id_token, jwks.get(p)!, { audience: c.id });
  if (!PROVIDERS[p].issuer(String(payload.iss))) throw badRequest("Unexpected token issuer");
  if (payload.nonce !== st.nonce) throw badRequest("Sign-in response didn't match this request");
  const email = String(payload.email ?? (p === "microsoft" ? payload.preferred_username : "") ?? "").toLowerCase();
  if (!email || !email.includes("@")) throw badRequest("Your account didn't share an email address");
  if (p === "google" && payload.email_verified !== true) throw badRequest("Your Google email address isn't verified");
  return { email, name: String(payload.name ?? email.split("@")[0]), provider: p, redirect: st.redirect };
}
