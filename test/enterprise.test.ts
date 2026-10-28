import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignedXml } from "xml-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
let idp: { key: string; cert: string };
beforeAll(async () => {
  ctx = await setup();
  // A throwaway identity provider key pair for signing test assertions.
  const dir = mkdtempSync(join(tmpdir(), "anvita-idp-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=Test IdP"], { stdio: "ignore" });
  idp = { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
});
afterAll(async () => ctx.app.close());

const PUBLIC = "http://localhost:4000";
const ISSUER = "https://idp.kesar.example/saml";

function samlResponse(workspaceId: string, o: { email: string; name?: string; id?: string; audience?: string; tamper?: string }) {
  const now = new Date();
  const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const acs = `${PUBLIC}/v1/auth/saml/${workspaceId}/acs`;
  const aud = o.audience ?? `${PUBLIC}/v1/auth/saml/${workspaceId}/metadata`;
  const assertionId = o.id ?? `_a${Math.random().toString(36).slice(2)}`;
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso(0)}" Destination="${acs}"><saml:Issuer>${ISSUER}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${ISSUER}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(300_000)}" Recipient="${acs}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${aud}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${o.email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>${o.name ?? "Ana Rao"}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  const sig = new SignedXml({ privateKey: idp.key, publicCert: idp.cert, canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#", signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"], digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256" });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
  let signed = sig.getSignedXml();
  if (o.tamper) signed = signed.replace(`<saml:AttributeValue>${o.email}</saml:AttributeValue>`, `<saml:AttributeValue>${o.tamper}</saml:AttributeValue>`);
  return Buffer.from(signed).toString("base64");
}

async function postAcs(workspaceId: string, SAMLResponse: string) {
  const res = await ctx.app.inject({ method: "POST", url: `/v1/auth/saml/${workspaceId}/acs`, payload: new URLSearchParams({ SAMLResponse }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  expect(res.statusCode).toBe(302);
  const loc = String(res.headers.location);
  const frag = new URLSearchParams(loc.split("#")[1] ?? "");
  return { loc, token: frag.get("access_token"), error: new URL(loc).searchParams.get("sso_error") };
}

describe("SAML single sign-on", () => {
  it("signs people in with signed assertions, provisions them and blocks replays and tampering", async () => {
    const owner = await signup(ctx.app, { domain: "kesar.example" });
    const api = client(ctx.app, owner);
    const ws = owner.workspaceId;

    // Service provider details are available before configuring the IdP.
    const meta = await ctx.app.inject({ method: "GET", url: `/v1/auth/saml/${ws}/metadata` });
    expect(meta.body).toContain(`/v1/auth/saml/${ws}/acs`);

    expect((await api.put("/v1/workspace/sso", { enabled: true, domains: ["gmail.com"] })).status).toBe(400);
    const cfg = await api.put("/v1/workspace/sso", { enabled: true, entryPoint: "https://idp.kesar.example/sso", idpIssuer: ISSUER, idpCert: idp.cert, domains: ["kesar.example"], defaultRole: "builder" });
    expect(cfg.status, JSON.stringify(cfg.body)).toBe(200);
    expect(cfg.body).toMatchObject({ enabled: true, hasCertificate: true, sp: { acsUrl: `${PUBLIC}/v1/auth/saml/${ws}/acs` } });

    const disc = (await ctx.app.inject({ method: "GET", url: "/v1/auth/sso/discover?email=ana@kesar.example" })).json();
    expect(disc).toMatchObject({ method: "saml", loginUrl: `${PUBLIC}/v1/auth/saml/${ws}/login` });
    const start = await ctx.app.inject({ method: "GET", url: `/v1/auth/saml/${ws}/login?redirect=/workers` });
    expect(start.statusCode).toBe(302);
    expect(String(start.headers.location)).toMatch(/^https:\/\/idp\.kesar\.example\/sso\?SAMLRequest=.+&RelayState=/);

    const resp = samlResponse(ws, { email: "ana@kesar.example" });
    const ok = await postAcs(ws, resp);
    expect(ok.error).toBeNull();
    const me = (await client(ctx.app, { token: ok.token! }).get("/v1/me")).body;
    expect(me.user).toMatchObject({ email: "ana@kesar.example", name: "Ana Rao" });
    expect(me.workspaces).toEqual([expect.objectContaining({ id: ws, role: "builder" })]);

    expect((await postAcs(ws, resp)).error).toMatch(/already used/);
    expect((await postAcs(ws, samlResponse(ws, { email: "ana@kesar.example", tamper: "boss@kesar.example" }))).error).toMatch(/SAML sign-in failed/);
    expect((await postAcs(ws, samlResponse(ws, { email: "eve@kesar.example", audience: "https://evil.example" }))).error).toMatch(/SAML sign-in failed/);
    expect((await postAcs(ws, samlResponse(ws, { email: "x@other.example" }))).error).toMatch(/isn't in a domain/);

    // Enforced SSO: password sign-in is refused for the domain.
    await api.put("/v1/workspace/sso", { enforced: true });
    const login = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", remoteAddress: "10.77.0.1", payload: { email: owner.email, password: "correct-horse-battery" } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toMatchObject({ code: "sso_required", details: { loginUrl: `${PUBLIC}/v1/auth/saml/${ws}/login` } });
  });
});

describe("SCIM 2.0 provisioning", () => {
  it("provisions, updates, deprovisions and assigns roles", async () => {
    const owner = await signup(ctx.app, { domain: "acme-scim.example" });
    const api = client(ctx.app, owner);
    const tok = (await api.post("/v1/workspace/scim-token")).body;
    expect(tok.token).toMatch(/^scim_/);
    const scim = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, token = tok.token) =>
      ctx.app.inject({ method, url: `/v1/scim/v2${url}`, payload: body ? JSON.stringify(body) : undefined, headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" } });

    expect((await scim("GET", "/Users", undefined, "scim_nope")).json()).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    expect((await scim("GET", "/ServiceProviderConfig")).json().patch.supported).toBe(true);

    const created = await scim("POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "Vik@Acme-Scim.example", externalId: "okta-123", name: { givenName: "Vik", familyName: "Shah" }, emails: [{ value: "vik@acme-scim.example", primary: true }], active: true });
    expect(created.statusCode).toBe(201);
    expect(created.headers["content-type"]).toMatch(/application\/scim\+json/);
    const u = created.json();
    expect(u).toMatchObject({ userName: "vik@acme-scim.example", displayName: "Vik Shah", active: true, externalId: "okta-123" });
    expect((await scim("POST", "/Users", { userName: "vik@acme-scim.example" })).statusCode).toBe(409);

    const found = (await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "vik@acme-scim.example"')}`)).json();
    expect(found).toMatchObject({ totalResults: 1, Resources: [{ id: u.id }] });
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('externalId eq "okta-123"')}`)).json().totalResults).toBe(1);

    // Roles via groups.
    const groups = (await scim("GET", "/Groups")).json();
    expect(groups.Resources.map((g: any) => g.id)).toEqual(["role-admin", "role-builder", "role-member", "role-viewer"]);
    await scim("PATCH", "/Groups/role-admin", { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "add", path: "members", value: [{ value: u.id }] }] });
    expect((await scim("GET", `/Users/${u.id}`)).json().roles[0].value).toBe("admin");

    // Deactivate (Okta style) then reactivate (Entra style), then delete.
    const off = (await scim("PATCH", `/Users/${u.id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] })).json();
    expect(off.active).toBe(false);
    const members = (await api.get("/v1/members")).body.data;
    expect(members.find((m: any) => m.email === "vik@acme-scim.example").status).toBe("suspended");
    expect((await scim("PATCH", `/Users/${u.id}`, { Operations: [{ op: "Replace", value: { active: true, displayName: "Vikram Shah" } }] })).json()).toMatchObject({ active: true, displayName: "Vikram Shah" });
    expect((await scim("DELETE", `/Users/${u.id}`)).statusCode).toBe(204);
    expect((await scim("GET", `/Users/${u.id}`)).statusCode).toBe(404);

    // The owner can't be deprovisioned by the IdP.
    const ownerRow = (await scim("GET", `/Users?filter=${encodeURIComponent(`userName eq "${owner.email}"`)}`)).json().Resources[0];
    expect((await scim("PATCH", `/Users/${ownerRow.id}`, { Operations: [{ op: "replace", path: "active", value: false }] })).statusCode).toBe(400);

    // Revoking the token cuts the IdP off.
    await api.del("/v1/workspace/scim-token");
    expect((await scim("GET", "/Users")).statusCode).toBe(401);
  });
});
