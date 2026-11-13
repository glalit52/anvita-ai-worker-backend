import { connectorFor } from "./index.js";
import { config } from "../config.js";
import { redirectUri } from "./oauth.js";

/**
 * Step-by-step setup guides shown in the Connect dialog. `steps` is for whoever connects the app
 * with a key/token; `oauthAdmin` is for the server operator enabling "Sign in with …" (one OAuth
 * app per provider, configured through environment variables).
 */

export interface Guide {
  steps: string[];
  docsUrl?: string;
  /** Least-privilege advice shown under the steps. */
  permissions?: string;
}

const GUIDES: Record<string, Guide> = {
  slack: {
    steps: ["Go to api.slack.com/apps → Create New App → From scratch, and pick your workspace.", "OAuth & Permissions → add bot scopes chat:write, users:read, users:read.email, im:write, channels:history, app_mentions:read.", "Install to Workspace, then copy the Bot User OAuth Token (xoxb-…) and paste it here.", "To chat with Anvita in Slack: Event Subscriptions → Request URL {API}/hooks/slack/events, subscribe to app_mention and message.im. For Approve / Reject buttons: Interactivity → Request URL {API}/hooks/slack/interactive."],
    docsUrl: "https://api.slack.com/apps",
    permissions: "Invite the app only to the channels it should read or post in.",
  },
  whatsapp: {
    steps: ["In Meta for Developers create an app of type Business and add the WhatsApp product.", "WhatsApp → API Setup: copy the Phone number ID. Create a permanent token for a system user (Business Settings → System users) with whatsapp_business_messaging.", "App settings → Basic: copy the App secret (used to verify webhooks).", "Choose any verify token and paste all four values here. Then WhatsApp → Configuration → Webhook: callback URL {API}/hooks/whatsapp with the same verify token, and subscribe to messages."],
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
  },
  hubspot: {
    steps: ["HubSpot → Settings → Integrations → Private apps → Create a private app.", "Scopes: crm.objects.contacts/deals/companies read (add write only if Workers should update records).", "Create the app and copy its access token (pat-…)."],
    docsUrl: "https://developers.hubspot.com/docs/api/private-apps",
    permissions: "Start read-only; approval policies still gate every write.",
  },
  zendesk: {
    steps: ["Zendesk Admin Center → Apps and integrations → APIs → Zendesk API.", "Enable Token access and add an API token.", "Paste your subdomain (the part before .zendesk.com), the agent email the token acts as, and the token."],
    docsUrl: "https://developer.zendesk.com/api-reference/introduction/security-and-auth/",
  },
  freshdesk: { steps: ["In Freshdesk click your profile picture → Profile settings.", "Copy Your API key from the right-hand panel.", "Paste it with your helpdesk domain (yourcompany.freshdesk.com)."], docsUrl: "https://developers.freshdesk.com/api/#authentication" },
  intercom: { steps: ["Intercom → Settings → Integrations → Developer Hub → New app (internal).", "Open the app → Authentication and copy the access token."], docsUrl: "https://developers.intercom.com/docs/build-an-integration/learn-more/authentication" },
  shopify: {
    steps: ["Shopify admin → Settings → Apps and sales channels → Develop apps → Create an app.", "Configure Admin API scopes: read_orders, read_products, read_customers, read_inventory (add write scopes only if needed).", "Install the app and reveal the Admin API access token (shpat_…) — it's shown once.", "Paste it with your store domain (yourstore.myshopify.com)."],
    docsUrl: "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin",
  },
  razorpay: { steps: ["Razorpay Dashboard → Account & Settings → API keys → Generate key.", "Use Test mode keys on staging and Live mode keys in production.", "Paste the Key ID and Key secret."], docsUrl: "https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/" },
  stripe: { steps: ["Stripe Dashboard → Developers → API keys → Create restricted key.", "Grant read access to the resources Workers need (charges, customers, invoices); write access to refunds only if Workers should issue them.", "Paste the key (rk_live_… or rk_test_…)."], docsUrl: "https://docs.stripe.com/keys", permissions: "Prefer a restricted key over the secret key." },
  delhivery: { steps: ["Delhivery One → Settings → API setup.", "Copy the API token for your account and paste it here."] },
  tally: { steps: ["In Tally Prime press F1 → Settings → Connectivity and enable the client/server with HTTP on port 9000.", "Expose it through an authenticated HTTPS tunnel (e.g. a reverse proxy with basic auth) — never open port 9000 to the internet directly.", "Paste the tunnel URL, the company name exactly as in Tally, and the tunnel credentials."] },
  darwinbox: { steps: ["Darwinbox → Settings → Integrations → API: create API credentials.", "Create an employee master dataset and copy its dataset key.", "Paste the domain, API user, password, API key and dataset key."] },
  workday: { steps: ["Workday: Register API Client for Integrations with scopes Staffing and Worker Data.", "Generate a non-expiring refresh token for an integration system user.", "Paste the host, tenant, client ID, client secret and refresh token."] },
  postgres: { steps: ["Create a dedicated role: CREATE ROLE anvita_reader LOGIN PASSWORD '…'; GRANT pg_read_all_data TO anvita_reader; (or GRANT SELECT on specific schemas).", "Allow the Anvita server's IP in your firewall / security group.", "Paste the connection URL: postgres://anvita_reader:…@host:5432/db?sslmode=require."], permissions: "Anvita only runs SELECT in read-only transactions with a timeout, but the role should be read-only too." },
  metaads: { steps: ["Meta Business Settings → Users → System users → Add (Employee).", "Assign your ad account to the system user with View performance.", "Generate token with ads_read, then paste it with the ad account ID (act_…)."], docsUrl: "https://developers.facebook.com/docs/marketing-api/overview/authorization" },
  mailchimp: { steps: ["Mailchimp → Profile → Extras → API keys → Create A Key.", "Paste the key (it ends with your data centre, e.g. -us21)."], docsUrl: "https://mailchimp.com/developer/marketing/guides/quick-start/" },
  notion: { steps: ["Go to notion.so/my-integrations → New integration (internal) for your workspace.", "Copy the Internal Integration Secret.", "In Notion, open each page or database Anvita should read → ••• → Connections → add your integration."], docsUrl: "https://developers.notion.com/docs/create-a-notion-integration" },
  github: { steps: ["GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.", "Limit it to the repositories Workers need, with read access to Issues, Pull requests and Contents.", "Paste the token (github_pat_…)."], docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens" },
  jira: { steps: ["Sign in at id.atlassian.com → Security → Create and manage API tokens → Create API token.", "Paste your site (yourcompany.atlassian.net), the account email and the token."], docsUrl: "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/" },
  linear: { steps: ["Linear → Settings → Security & access → Personal API keys → New key.", "Paste the key (lin_api_…)."], docsUrl: "https://linear.app/developers" },
  okta: { steps: ["Okta Admin Console → Security → API → Tokens → Create token.", "Use a read-only admin for the token's owner where possible.", "Paste your Okta domain (yourcompany.okta.com) and the token."], docsUrl: "https://developer.okta.com/docs/guides/create-an-api-token/main/" },
};

/** OAuth app setup for the server operator, by provider family (the connector's `env` prefix). */
const OAUTH_ADMIN: Record<string, { console: string; steps: string[]; docsUrl?: string }> = {
  GOOGLE: { console: "Google Cloud Console", steps: ["APIs & Services → Credentials → Create OAuth client ID (Web application).", "Enable the APIs you use (Gmail, Drive, Calendar, Sheets, Google Ads, BigQuery, Analytics Data).", "Configure the OAuth consent screen; external apps with Gmail scopes need Google verification."], docsUrl: "https://developers.google.com/identity/protocols/oauth2/web-server" },
  MICROSOFT: { console: "Microsoft Entra admin center", steps: ["App registrations → New registration (multitenant if customers use their own tenants).", "Certificates & secrets → New client secret.", "API permissions → Microsoft Graph delegated permissions for Mail, Calendars, Teams, offline_access."], docsUrl: "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app" },
  SLACK: { console: "api.slack.com/apps", steps: ["Create a distributable app; OAuth & Permissions → add the redirect URL and bot scopes.", "Manage Distribution → activate public distribution."] },
  HUBSPOT: { console: "HubSpot developer account", steps: ["Create a public app; Auth → add the redirect URL and CRM scopes."], docsUrl: "https://developers.hubspot.com/docs/api/oauth-quickstart-guide" },
  SALESFORCE: { console: "Salesforce Setup", steps: ["App Manager → New Connected App → Enable OAuth Settings with scopes api and refresh_token."] },
  ZENDESK: { console: "Zendesk Admin Center", steps: ["Apps and integrations → APIs → OAuth Clients → Add OAuth client (or a global OAuth client for many subdomains)."] },
  SHOPIFY: { console: "Shopify Partners", steps: ["Apps → Create app; set the allowed redirection URL and Admin API scopes."] },
  NOTION: { console: "notion.so/my-integrations", steps: ["Create a public integration with the redirect URI."] },
  GITHUB: { console: "GitHub Developer settings", steps: ["OAuth Apps (or a GitHub App) → New; set the callback URL."] },
  QUICKBOOKS: { console: "Intuit Developer", steps: ["Create an app with the Accounting scope; add the redirect URI under Keys & credentials."] },
  ZOHO: { console: "Zoho API Console", steps: ["Add Client → Server-based Applications; set the redirect URI. Use the accounts domain of your data centre."] },
};

export function guideFor(appId: string) {
  const c = connectorFor(appId);
  const g = GUIDES[appId];
  const env = c?.oauth?.env;
  const admin = env ? OAUTH_ADMIN[env] : undefined;
  if (!g && !admin) return null;
  const api = `${config.PUBLIC_URL}/v1`;
  return {
    ...(g ?? { steps: [] }),
    steps: (g?.steps ?? []).map((x) => x.replaceAll("{API}", api)),
    ...(admin && env ? { oauthAdmin: { ...admin, env: [`${env}_CLIENT_ID`, `${env}_CLIENT_SECRET`], redirectUri: redirectUri() } } : {}),
  };
}
