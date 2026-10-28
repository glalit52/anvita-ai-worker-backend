import { ConnectorError, type AppConnector, type Credentials } from "./types.js";

/**
 * How each app authenticates. OAuth apps need `<ENV>_CLIENT_ID` / `<ENV>_CLIENT_SECRET` set on
 * the server; API-key apps need nothing server-side. Apps without an entry use the demo driver.
 */

const bearer = (c: Credentials) => ({ Authorization: `Bearer ${c.accessToken ?? c.fields?.token ?? c.fields?.access_token ?? c.fields?.botToken ?? ""}` });
const basic = (user: string, pass: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` });
export const host = (v: string | undefined) => (v ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
export const zendeskSub = (v: string | undefined) => host(v).replace(/\.zendesk\.com$/, "");

const GOOGLE = (scopes: string[]): AppConnector["oauth"] => ({
  env: "GOOGLE",
  authorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: () => "https://oauth2.googleapis.com/token",
  scopes: ["openid", "email", ...scopes],
  extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
});

const MICROSOFT = (scopes: string[]): AppConnector["oauth"] => ({
  env: "MICROSOFT",
  authorizeUrl: () => `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT ?? "common"}/oauth2/v2.0/authorize`,
  tokenUrl: () => `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT ?? "common"}/oauth2/v2.0/token`,
  scopes: ["offline_access", "User.Read", ...scopes],
});

export const CONNECTORS: AppConnector[] = [
  // ─── Google Workspace ───
  { appId: "gmail", oauth: GOOGLE(["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"]), headers: bearer, test: async (call) => `Connected as ${(await call<{ emailAddress: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile")).emailAddress}` },
  { appId: "gdrive", oauth: GOOGLE(["https://www.googleapis.com/auth/drive.readonly"]), headers: bearer, test: async (call) => `Connected as ${(await call<{ user: { emailAddress: string } }>("https://www.googleapis.com/drive/v3/about?fields=user")).user.emailAddress}` },
  { appId: "gcal", oauth: GOOGLE(["https://www.googleapis.com/auth/calendar.readonly"]), headers: bearer, test: async (call) => `Calendar ${(await call<{ summary: string }>("https://www.googleapis.com/calendar/v3/calendars/primary")).summary}` },
  { appId: "gsheets", oauth: GOOGLE(["https://www.googleapis.com/auth/spreadsheets"]), headers: bearer },
  { appId: "ga4", oauth: { ...GOOGLE(["https://www.googleapis.com/auth/analytics.readonly"])!, needs: [{ key: "propertyId", label: "GA4 property ID", placeholder: "123456789" }] }, headers: bearer },

  // ─── Microsoft 365 ───
  { appId: "outlook", oauth: MICROSOFT(["Mail.Send", "Mail.Read", "Calendars.Read"]), headers: bearer, test: async (call) => `Connected as ${(await call<{ userPrincipalName: string }>("https://graph.microsoft.com/v1.0/me")).userPrincipalName}` },
  { appId: "teams", oauth: MICROSOFT(["ChannelMessage.Send", "Team.ReadBasic.All", "Channel.ReadBasic.All"]), headers: bearer },

  // ─── Communication ───
  {
    appId: "slack",
    oauth: {
      env: "SLACK",
      authorizeUrl: () => "https://slack.com/oauth/v2/authorize",
      tokenUrl: () => "https://slack.com/api/oauth.v2.access",
      scopes: ["app_mentions:read", "chat:write", "channels:read", "channels:history", "im:history", "im:write", "users:read", "users:read.email"],
      scopeSeparator: ",",
      extract: (t) => ({ teamId: String((t.team as { id?: string })?.id ?? ""), teamName: String((t.team as { name?: string })?.name ?? ""), botUserId: String(t.bot_user_id ?? "") }),
    },
    apiKey: { fields: [{ key: "botToken", label: "Bot token", secret: true, placeholder: "xoxb-…" }], help: "Create a Slack app, install it to your workspace and paste its Bot User OAuth Token." },
    headers: bearer,
    test: async (call) => {
      const r = await call<{ ok: boolean; team: string; team_id: string; user_id?: string; error?: string }>("https://slack.com/api/auth.test", { method: "POST" });
      if (!r.ok) throw new ConnectorError(r.error ?? "Slack auth failed", r.error === "invalid_auth" ? 401 : undefined);
      return { detail: `Connected to ${r.team}`, extra: { teamId: r.team_id, teamName: r.team, ...(r.user_id ? { botUserId: r.user_id } : {}) } };
    },
  },
  {
    appId: "whatsapp",
    apiKey: {
      fields: [
        { key: "access_token", label: "Permanent access token", secret: true },
        { key: "phone_number_id", label: "Phone number ID" },
        { key: "app_secret", label: "App secret (verifies webhooks)", secret: true },
        { key: "verify_token", label: "Webhook verify token", placeholder: "any random string" },
      ],
      help: "From Meta for Developers → WhatsApp → API Setup. Point the webhook at the URL shown after connecting.",
    },
    headers: bearer,
    test: async (call) => `Number ${(await call<{ display_phone_number: string }>("https://graph.facebook.com/v21.0/{phone_number_id}")).display_phone_number}`,
  },

  // ─── CRM & sales ───
  {
    appId: "hubspot",
    oauth: { env: "HUBSPOT", authorizeUrl: () => "https://app.hubspot.com/oauth/authorize", tokenUrl: () => "https://api.hubapi.com/oauth/v1/token", scopes: ["crm.objects.deals.read", "crm.objects.deals.write", "crm.objects.contacts.read", "oauth"] },
    apiKey: { fields: [{ key: "token", label: "Private app access token", secret: true, placeholder: "pat-…" }], help: "HubSpot → Settings → Integrations → Private apps." },
    headers: bearer,
    test: async (call) => `Portal ${(await call<{ portalId: number }>("https://api.hubapi.com/account-info/v3/details")).portalId}`,
  },
  {
    appId: "salesforce",
    oauth: {
      env: "SALESFORCE",
      authorizeUrl: () => `${process.env.SALESFORCE_LOGIN_URL ?? "https://login.salesforce.com"}/services/oauth2/authorize`,
      tokenUrl: () => `${process.env.SALESFORCE_LOGIN_URL ?? "https://login.salesforce.com"}/services/oauth2/token`,
      scopes: ["api", "refresh_token"],
      extract: (t) => ({ instanceUrl: String(t.instance_url ?? "") }),
    },
    headers: bearer,
  },

  // ─── Support ───
  {
    appId: "zendesk",
    oauth: { env: "ZENDESK", authorizeUrl: (e) => `https://${zendeskSub(e.subdomain)}.zendesk.com/oauth/authorizations/new`, tokenUrl: (e) => `https://${zendeskSub(e.subdomain)}.zendesk.com/oauth/tokens`, scopes: ["read", "write"], needs: [{ key: "subdomain", label: "Zendesk subdomain", placeholder: "kesarfoods" }] },
    apiKey: { fields: [{ key: "subdomain", label: "Subdomain", placeholder: "kesarfoods" }, { key: "email", label: "Agent email" }, { key: "token", label: "API token", secret: true }], help: "Zendesk Admin → Apps and integrations → Zendesk API → add API token." },
    headers: (c) => (c.kind === "oauth" ? bearer(c) : basic(`${c.fields?.email}/token`, c.fields?.token ?? "")),
    test: async (call) => `Agent ${(await call<{ user: { email: string } }>("https://{subdomain}.zendesk.com/api/v2/users/me.json")).user.email}`,
  },
  {
    appId: "freshdesk",
    apiKey: { fields: [{ key: "domain", label: "Freshdesk domain", placeholder: "kesarfoods.freshdesk.com" }, { key: "token", label: "API key", secret: true }], help: "Freshdesk → Profile settings → Your API key." },
    headers: (c) => basic(c.fields?.token ?? "", "X"),
  },
  {
    appId: "intercom",
    apiKey: { fields: [{ key: "token", label: "Access token", secret: true }], help: "Intercom Developer Hub → your app → Authentication." },
    headers: (c) => ({ ...bearer(c), "Intercom-Version": "2.11" }),
  },

  // ─── Commerce & finance ───
  {
    appId: "shopify",
    oauth: { env: "SHOPIFY", authorizeUrl: (e) => `https://${host(e.shop)}/admin/oauth/authorize`, tokenUrl: (e) => `https://${host(e.shop)}/admin/oauth/access_token`, scopes: ["read_orders", "read_products", "read_customers"], needs: [{ key: "shop", label: "Shop domain", placeholder: "kesarfoods.myshopify.com" }] },
    apiKey: { fields: [{ key: "shop", label: "Shop domain", placeholder: "kesarfoods.myshopify.com" }, { key: "token", label: "Admin API access token", secret: true, placeholder: "shpat_…" }], help: "Shopify admin → Settings → Apps → Develop apps → Admin API access token." },
    headers: (c) => ({ "X-Shopify-Access-Token": c.accessToken ?? c.fields?.token ?? "" }),
    test: async (call) => `Shop ${(await call<{ shop: { name: string } }>("https://{shop}/admin/api/2025-10/shop.json")).shop.name}`,
  },
  {
    appId: "razorpay",
    apiKey: { fields: [{ key: "key_id", label: "Key ID", placeholder: "rzp_live_…" }, { key: "key_secret", label: "Key secret", secret: true }], help: "Razorpay Dashboard → Account & Settings → API keys." },
    headers: (c) => basic(c.fields?.key_id ?? "", c.fields?.key_secret ?? ""),
    test: async (call) => `${(await call<{ count: number }>("https://api.razorpay.com/v1/payments?count=1")).count >= 0 ? "Keys valid" : ""}`,
  },
  {
    appId: "stripe",
    apiKey: { fields: [{ key: "token", label: "Secret key", secret: true, placeholder: "sk_live_… or rk_live_…" }], help: "Stripe Dashboard → Developers → API keys (a restricted key is recommended)." },
    headers: bearer,
    test: async (call) => `Account ${(await call<{ id: string }>("https://api.stripe.com/v1/account")).id}`,
  },
  {
    appId: "delhivery",
    apiKey: { fields: [{ key: "token", label: "API token", secret: true }], help: "Delhivery One → Settings → API setup." },
    headers: (c) => ({ Authorization: `Token ${c.fields?.token ?? ""}` }),
  },

  // ─── Marketing ───
  {
    appId: "metaads",
    apiKey: { fields: [{ key: "access_token", label: "System user access token", secret: true }, { key: "ad_account_id", label: "Ad account ID", placeholder: "act_1234… or 1234…" }], help: "Meta Business Settings → System users → Generate token with ads_read." },
    headers: bearer,
    test: async (call) => `Ad account ${(await call<{ name: string }>("https://graph.facebook.com/v21.0/act_{ad_account_id}?fields=name")).name}`,
  },
  {
    appId: "mailchimp",
    apiKey: { fields: [{ key: "token", label: "API key", secret: true, placeholder: "…-us21" }], help: "Mailchimp → Profile → Extras → API keys." },
    headers: (c) => basic("anvita", c.fields?.token ?? ""),
  },

  // ─── Productivity & engineering ───
  {
    appId: "notion",
    oauth: { env: "NOTION", authorizeUrl: () => "https://api.notion.com/v1/oauth/authorize", tokenUrl: () => "https://api.notion.com/v1/oauth/token", scopes: [], tokenAuth: "basic", tokenJson: true, extraAuthParams: { owner: "user" }, extract: (t) => ({ workspaceName: String(t.workspace_name ?? "") }) },
    apiKey: { fields: [{ key: "token", label: "Internal integration secret", secret: true, placeholder: "ntn_…" }], help: "notion.so/my-integrations → New integration, then share pages with it." },
    headers: (c) => ({ ...bearer(c), "Notion-Version": "2022-06-28" }),
    test: async (call) => `Bot ${(await call<{ name: string }>("https://api.notion.com/v1/users/me")).name}`,
  },
  {
    appId: "github",
    oauth: { env: "GITHUB", authorizeUrl: () => "https://github.com/login/oauth/authorize", tokenUrl: () => "https://github.com/login/oauth/access_token", scopes: ["repo", "read:user"], scopeSeparator: " " },
    apiKey: { fields: [{ key: "token", label: "Fine-grained personal access token", secret: true, placeholder: "github_pat_…" }], help: "GitHub → Settings → Developer settings → Personal access tokens." },
    headers: (c) => ({ ...bearer(c), Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }),
    test: async (call) => `Connected as ${(await call<{ login: string }>("https://api.github.com/user")).login}`,
  },
  {
    appId: "jira",
    apiKey: { fields: [{ key: "site", label: "Site", placeholder: "kesarfoods.atlassian.net" }, { key: "email", label: "Account email" }, { key: "token", label: "API token", secret: true }], help: "id.atlassian.com → Security → API tokens." },
    headers: (c) => basic(c.fields?.email ?? "", c.fields?.token ?? ""),
    test: async (call) => `Connected as ${(await call<{ emailAddress: string }>("https://{site}/rest/api/3/myself")).emailAddress}`,
  },
  {
    appId: "linear",
    apiKey: { fields: [{ key: "token", label: "Personal API key", secret: true, placeholder: "lin_api_…" }], help: "Linear → Settings → Security & access → Personal API keys." },
    headers: (c) => ({ Authorization: c.fields?.token ?? "" }),
  },
  {
    appId: "okta",
    apiKey: { fields: [{ key: "domain", label: "Okta domain", placeholder: "kesarfoods.okta.com" }, { key: "token", label: "API token", secret: true }], help: "Okta Admin → Security → API → Tokens." },
    headers: (c) => ({ Authorization: `SSWS ${c.fields?.token ?? ""}` }),
  },
];

export const connectorFor = (appId: string) => CONNECTORS.find((c) => c.appId === appId);

export function oauthConfigured(appId: string): boolean {
  const o = connectorFor(appId)?.oauth;
  return !!o && !!process.env[`${o.env}_CLIENT_ID`] && !!process.env[`${o.env}_CLIENT_SECRET`];
}
