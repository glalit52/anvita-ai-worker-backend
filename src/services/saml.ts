import { X509Certificate, createHash } from "node:crypto";
import { SAML, type Profile } from "@node-saml/node-saml";
import { and, arrayContains, eq, lt } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { samlReplays, ssoConfigs } from "../db/schema.js";
import { badRequest } from "../lib/errors.js";

/**
 * SAML 2.0 service provider, one per workspace (Okta, Entra ID, Google Workspace, OneLogin,
 * JumpCloud…). SP-initiated (HTTP-Redirect AuthnRequest) and IdP-initiated logins; assertions
 * must be signed by the configured IdP certificate, are audience- and time-checked, and each
 * assertion id is accepted once.
 */

export type SsoConfig = typeof ssoConfigs.$inferSelect;
const secret = new TextEncoder().encode(config.JWT_SECRET);

export const spEntityId = (workspaceId: string) => `${config.PUBLIC_URL}/v1/auth/saml/${workspaceId}/metadata`;
export const acsUrl = (workspaceId: string) => `${config.PUBLIC_URL}/v1/auth/saml/${workspaceId}/acs`;
export const samlLoginUrl = (workspaceId: string) => `${config.PUBLIC_URL}/v1/auth/saml/${workspaceId}/login`;

/** Normalise pasted certificates (PEM or bare base64) and check they parse. */
export function normaliseCerts(raw: string): string[] {
  const blocks = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [`-----BEGIN CERTIFICATE-----\n${raw.replace(/\s+/g, "").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`];
  return blocks.map((pem) => {
    try {
      const c = new X509Certificate(pem);
      if (Date.parse(c.validTo) < Date.now()) throw badRequest(`The IdP certificate expired on ${c.validTo}`);
      return c.toString();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode) throw e;
      throw badRequest("The IdP certificate isn't a valid X.509 certificate");
    }
  });
}

function samlFor(cfg: SsoConfig) {
  if (!cfg.enabled || !cfg.entryPoint || !cfg.idpCert) throw badRequest("SAML single sign-on isn't set up for this workspace");
  return new SAML({
    entryPoint: cfg.entryPoint,
    issuer: spEntityId(cfg.workspaceId),
    callbackUrl: acsUrl(cfg.workspaceId),
    audience: spEntityId(cfg.workspaceId),
    idpIssuer: cfg.idpIssuer ?? undefined,
    idpCert: normaliseCerts(cfg.idpCert),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 120_000,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    disableRequestedAuthnContext: true,
    validateInResponseTo: "never" as never,
  });
}

export async function ssoConfigFor(workspaceId: string): Promise<SsoConfig | null> {
  const [c] = await db.select().from(ssoConfigs).where(eq(ssoConfigs.workspaceId, workspaceId));
  return c ?? null;
}

/** Workspace whose enabled SAML config claims this email's domain. */
export async function ssoForEmail(email: string): Promise<SsoConfig | null> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  const [c] = await db.select().from(ssoConfigs).where(and(eq(ssoConfigs.enabled, true), arrayContains(ssoConfigs.domains, [domain])));
  return c ?? null;
}

export async function samlStartUrl(cfg: SsoConfig, redirect: string): Promise<string> {
  const relay = await new SignJWT({ typ: "saml_relay", ws: cfg.workspaceId, redirect }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("15m").sign(secret);
  return samlFor(cfg).getAuthorizeUrlAsync(relay, undefined, {});
}

export function samlMetadata(workspaceId: string): string {
  const saml = new SAML({ issuer: spEntityId(workspaceId), callbackUrl: acsUrl(workspaceId), idpCert: "unused", identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" });
  return saml.generateServiceProviderMetadata(null, null);
}

const attr = (p: Profile, ...names: string[]) => {
  for (const n of names) {
    const v = p[n];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === "string") return String(v[0]).trim();
  }
  return "";
};

export interface SamlIdentity { email: string; name: string; redirect: string }

/** Validate the IdP's POSTed response and return who signed in. */
export async function samlFinish(cfg: SsoConfig, body: { SAMLResponse?: string; RelayState?: string }): Promise<SamlIdentity> {
  if (!body.SAMLResponse) throw badRequest("Missing SAMLResponse");
  let profile: Profile | null;
  try {
    ({ profile } = await samlFor(cfg).validatePostResponseAsync({ SAMLResponse: body.SAMLResponse }));
  } catch (e) {
    throw badRequest(`SAML sign-in failed: ${(e as Error).message}`);
  }
  if (!profile) throw badRequest("SAML sign-in failed: no profile in the response");

  // Replay protection: each assertion id is accepted once (until it would have expired anyway).
  const assertion = profile.getAssertion?.() as { Assertion?: { $?: { ID?: string } } } | undefined;
  const assertionId = assertion?.Assertion?.$?.ID ?? profile.ID ?? `${profile.issuer}|${profile.nameID}|${profile.sessionIndex ?? ""}`;
  const key = createHash("sha256").update(`${cfg.workspaceId}|${assertionId}`).digest("hex");
  await db.delete(samlReplays).where(lt(samlReplays.expiresAt, new Date()));
  const inserted = await db.insert(samlReplays).values({ id: key, expiresAt: new Date(Date.now() + 24 * 3600_000) }).onConflictDoNothing().returning();
  if (!inserted.length) throw badRequest("This sign-in response was already used");

  const email = (attr(profile, "email", "mail", "urn:oid:0.9.2342.19200300.100.1.3", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "Email") || (profile.nameID.includes("@") ? profile.nameID : "")).toLowerCase();
  if (!email.includes("@")) throw badRequest("The identity provider didn't send an email address");
  if (cfg.domains.length && !cfg.domains.includes(email.split("@")[1])) throw badRequest(`${email} isn't in a domain this workspace accepts`);
  const name = attr(profile, "displayName", "name", "http://schemas.microsoft.com/identity/claims/displayname") || [attr(profile, "firstName", "givenName", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"), attr(profile, "lastName", "surname", "sn", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname")].filter(Boolean).join(" ") || email.split("@")[0];

  let redirect = "/home";
  if (body.RelayState) {
    try {
      const { payload } = await jwtVerify(body.RelayState, secret, { algorithms: ["HS256"] });
      if (payload.typ === "saml_relay" && payload.ws === cfg.workspaceId && typeof payload.redirect === "string" && payload.redirect.startsWith("/")) redirect = payload.redirect;
    } catch {
      // IdP-initiated logins carry no (or a foreign) RelayState.
    }
  }
  return { email, name, redirect };
}
