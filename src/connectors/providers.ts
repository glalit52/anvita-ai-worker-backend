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
  { appId: "gcal", oauth: GOOGLE(["https://www.googleapis.com/auth/calendar.events"]), headers: bearer, test: async (call) => `Calendar ${(await call<{ summary: string }>("https://www.googleapis.com/calendar/v3/calendars/primary")).summary}` },
  { appId: "gsheets", oauth: GOOGLE(["https://www.googleapis.com/auth/spreadsheets"]), headers: bearer },
  {
    appId: "googleads",
    // Google Ads also needs the server's developer token (GOOGLE_ADS_DEVELOPER_TOKEN).
    oauth: { ...GOOGLE(["https://www.googleapis.com/auth/adwords"])!, needs: [{ key: "customer_id", label: "Google Ads customer ID", placeholder: "123-456-7890" }, { key: "login_customer_id", label: "Manager (MCC) account ID", placeholder: "optional", optional: true }] },
    headers: (c) => ({ ...bearer(c), "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "", ...(c.extra?.login_customer_id ? { "login-customer-id": c.extra.login_customer_id.replace(/\D/g, "") } : {}) }),
    test: async (call) => {
      const r = await call<{ results?: { customer: { descriptiveName: string; currencyCode: string } }[] }>("https://googleads.googleapis.com/v21/customers/{customer_id}/googleAds:search", { body: { query: "SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1" } });
      return `Account ${r.results?.[0]?.customer.descriptiveName ?? "connected"}`;
    },
  },
  {
    appId: "bigquery",
    oauth: { ...GOOGLE(["https://www.googleapis.com/auth/bigquery.readonly"])!, needs: [{ key: "project_id", label: "Google Cloud project ID", placeholder: "kesar-analytics" }] },
    headers: bearer,
    test: async (call) => `Project ${(await call<{ datasets?: unknown[] }>("https://bigquery.googleapis.com/bigquery/v2/projects/{project_id}/datasets?maxResults=1")).datasets ? "has datasets" : "connected"}`,
  },
  { appId: "ga4", oauth: { ...GOOGLE(["https://www.googleapis.com/auth/analytics.readonly"])!, needs: [{ key: "propertyId", label: "GA4 property ID", placeholder: "123456789" }] }, headers: bearer },

  // ─── Microsoft 365 ───
  { appId: "outlook", oauth: MICROSOFT(["Mail.Send", "Mail.Read", "Calendars.Read"]), headers: bearer, test: async (call) => `Connected as ${(await call<{ userPrincipalName: string }>("https://graph.microsoft.com/v1.0/me")).userPrincipalName}` },
  { appId: "teams", oauth: MICROSOFT(["ChannelMessage.Send", "Team.ReadBasic.All", "Channel.ReadBasic.All", "Chat.ReadWrite"]), headers: bearer, test: async (call) => `Member of ${(await call<{ value: unknown[] }>("https://graph.microsoft.com/v1.0/me/joinedTeams")).value.length} teams` },

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

  {
    appId: "tally",
    // Tally Prime's XML server runs on-prem (port 9000). Expose it to Anvita through a secure tunnel or the Tally gateway.
    apiKey: {
      fields: [
        { key: "url", label: "Tally gateway URL", placeholder: "https://tally.kesarfoods.in" },
        { key: "company", label: "Company name in Tally", placeholder: "Kesar Foods Pvt Ltd" },
        { key: "username", label: "Gateway username", optional: true },
        { key: "password", label: "Gateway password", secret: true, optional: true },
      ],
      help: "Enable Tally Prime's HTTP server (F1 → Settings → Connectivity → port 9000) and publish it through an authenticated HTTPS tunnel; paste that URL here.",
    },
    headers: (c) => ({ "Content-Type": "text/xml", ...(c.fields?.username ? basic(c.fields.username, c.fields.password ?? "") : {}) }),
    test: async (call) => {
      const xml = await call<string>("{url}", { method: "POST", raw: `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CompanyList</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="CompanyList"><TYPE>Company</TYPE><FETCH>NAME</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`, headers: { Accept: "text/xml" } });
      const names = [...String(xml).matchAll(/<COMPANY NAME="([^"]+)"/g)].map((m) => m[1]);
      return names.length ? `Companies: ${names.slice(0, 3).join(", ")}` : "Tally reachable";
    },
  },
  {
    appId: "quickbooks",
    oauth: { env: "QUICKBOOKS", authorizeUrl: () => "https://appcenter.intuit.com/connect/oauth2", tokenUrl: () => "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", scopes: ["com.intuit.quickbooks.accounting"], tokenAuth: "basic" },
    headers: bearer,
    test: async (call) => `Company ${(await call<{ CompanyInfo: { CompanyName: string } }>(`${qbBase()}/v3/company/{realmId}/companyinfo/{realmId}?minorversion=75`)).CompanyInfo.CompanyName}`,
  },
  {
    appId: "zoho",
    // Data centre comes from ZOHO_ACCOUNTS_URL (accounts.zoho.in for India); the API domain is returned with the token.
    oauth: {
      env: "ZOHO",
      authorizeUrl: () => `${process.env.ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.in"}/oauth/v2/auth`,
      tokenUrl: () => `${process.env.ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.in"}/oauth/v2/token`,
      scopes: ["ZohoCRM.modules.ALL", "ZohoCRM.settings.READ", "ZohoBooks.invoices.READ", "ZohoBooks.bills.CREATE", "ZohoBooks.settings.READ"],
      scopeSeparator: ",",
      extraAuthParams: { access_type: "offline", prompt: "consent" },
      extract: (t) => ({ apiDomain: String(t.api_domain ?? "https://www.zohoapis.in") }),
    },
    headers: (c) => ({ Authorization: `Zoho-oauthtoken ${c.accessToken ?? ""}` }),
    test: async (call) => `Org ${(await call<{ org: { company_name: string }[] }>("{apiDomain}/crm/v6/org")).org[0]?.company_name ?? "connected"}`,
  },
  {
    appId: "darwinbox",
    apiKey: {
      fields: [
        { key: "domain", label: "Darwinbox domain", placeholder: "kesarfoods.darwinbox.in" },
        { key: "username", label: "API username" },
        { key: "password", label: "API password", secret: true },
        { key: "api_key", label: "API key", secret: true },
        { key: "dataset_key", label: "Employee dataset key", secret: true },
      ],
      help: "Darwinbox → Settings → Integrations → API: create API credentials and an employee master dataset.",
    },
    headers: (c) => basic(c.fields?.username ?? "", c.fields?.password ?? ""),
    test: async (call, get) => {
      const r = await call<{ status?: number | string; employee_data?: unknown[]; message?: string }>("https://{domain}/masterapi/employee", { body: { api_key: get("api_key"), datasetKey: get("dataset_key") } });
      if (!Array.isArray(r.employee_data)) throw new ConnectorError(r.message ?? "Darwinbox rejected the API key or dataset key");
      return `${r.employee_data.length} employees visible`;
    },
  },
  {
    appId: "workday",
    // Workday API client (refresh token grant): the driver exchanges the refresh token per call.
    apiKey: {
      fields: [
        { key: "host", label: "Workday REST host", placeholder: "wd2-impl-services1.workday.com" },
        { key: "tenant", label: "Tenant", placeholder: "kesarfoods" },
        { key: "client_id", label: "API client ID" },
        { key: "client_secret", label: "API client secret", secret: true },
        { key: "refresh_token", label: "Refresh token", secret: true },
      ],
      help: "Workday → Register API Client for Integrations (scopes: Staffing, Worker Data), then generate a non-expiring refresh token.",
    },
    headers: () => ({}),
    dynamicHeaders: async (c) => ({ Authorization: `Bearer ${await workdayToken(c)}` }),
    test: async (call) => `${(await call<{ total?: number }>("https://{host}/ccx/api/staffing/v6/{tenant}/workers?limit=1")).total ?? 0} workers`,
  },
  {
    appId: "postgres",
    // Read-only SQL over a direct connection (use a read-only role). The URL never reaches the model.
    apiKey: { fields: [{ key: "dsn", label: "Connection URL", secret: true, placeholder: "postgres://readonly:…@db.example.com:5432/app?sslmode=require" }], help: "Create a read-only database role and paste its connection URL. Anvita runs SELECT queries in read-only transactions with a timeout." },
    headers: () => ({}),
    test: async (_call, get) => {
      const { pgQuery } = await import("./drivers/data.js");
      const r = await pgQuery(get("dsn") ?? "", "select current_database() as db, version() as version", 1);
      return `Database ${String(r.rows[0]?.db ?? "")}`;
    },
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

const workdayTokens = new Map<string, { token: string; exp: number }>();
/** Exchange the Workday refresh token for an access token (cached until shortly before expiry). */
async function workdayToken(c: Credentials): Promise<string> {
  const f = c.fields ?? {};
  const key = `${f.host}|${f.tenant}|${f.client_id}`;
  const hit = workdayTokens.get(key);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  const res = await fetch(`https://${host(f.host)}/ccx/oauth2/${encodeURIComponent(f.tenant ?? "")}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${f.client_id}:${f.client_secret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: f.refresh_token ?? "" }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) throw new ConnectorError(`Workday token request failed: ${data.error ?? res.status}`, 401);
  workdayTokens.set(key, { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

export const qbBase = () => (process.env.QUICKBOOKS_ENV === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com");

export const connectorFor = (appId: string) => CONNECTORS.find((c) => c.appId === appId);

export function oauthConfigured(appId: string): boolean {
  const o = connectorFor(appId)?.oauth;
  return !!o && !!process.env[`${o.env}_CLIENT_ID`] && !!process.env[`${o.env}_CLIENT_SECRET`];
}
