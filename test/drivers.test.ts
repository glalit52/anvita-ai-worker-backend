import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DRIVERS, runLive } from "../src/connectors/index.js";
import type { Credentials } from "../src/connectors/types.js";

/**
 * Every live driver against a mocked provider: right host + path, the app's auth header, and the
 * response parsed into the compact shape the agent sees.
 */

let original: Dispatcher;
beforeAll(() => (original = getGlobalDispatcher()));
afterAll(() => setGlobalDispatcher(original));

const oauth = (extra: Record<string, string> = {}): Credentials => ({ kind: "oauth", accessToken: "tok", expiresAt: Date.now() + 3600_000, extra });
const key = (fields: Record<string, string>): Credentials => ({ kind: "api_key", fields });

interface Case { times?: number; app: string; action: string; input: Record<string, unknown>; creds: Credentials; origin: string; path: string | RegExp; method?: string; auth: [string, string | RegExp]; reply: unknown; expect: Record<string, unknown> }

const now = new Date().toISOString();
const CASES: Case[] = [
  { app: "gmail", action: "gmail.send", input: { to: ["a@b.com"], subject: "Hi ✓", body: "Body" }, creds: oauth(), origin: "https://gmail.googleapis.com", path: "/gmail/v1/users/me/messages/send", method: "POST", auth: ["authorization", "Bearer tok"], reply: { id: "m1", threadId: "t1" }, expect: { sent: true, id: "m1" } },
  { app: "gcal", action: "gcal.events.list", input: { days: 3 }, creds: oauth(), origin: "https://www.googleapis.com", path: /^\/calendar\/v3\/calendars\/primary\/events/, auth: ["authorization", "Bearer tok"], reply: { items: [{ summary: "Sync", start: { dateTime: now }, end: { dateTime: now } }] }, expect: { events: [{ title: "Sync", start: now, end: now, attendees: 0, location: undefined }] } },
  { app: "gdrive", action: "gdrive.files.search", input: { query: "it's GST" }, creds: oauth(), origin: "https://www.googleapis.com", path: /^\/drive\/v3\/files\?.*q=fullText\+contains\+%27it%5C%27s\+GST%27\+and\+trashed/, auth: ["authorization", "Bearer tok"], reply: { files: [{ id: "f", name: "GST.xlsx" }] }, expect: { files: [{ id: "f", name: "GST.xlsx" }] } },
  { app: "gsheets", action: "gsheets.values.get", input: { spreadsheet_id: "sheet1", range: "A1:B2" }, creds: oauth(), origin: "https://sheets.googleapis.com", path: "/v4/spreadsheets/sheet1/values/A1%3AB2", auth: ["authorization", "Bearer tok"], reply: { range: "A1:B2", values: [["a", "b"]] }, expect: { rows: [["a", "b"]] } },
  { app: "ga4", action: "ga4.report", input: { range: "last_7d" }, creds: oauth({ propertyId: "123" }), origin: "https://analyticsdata.googleapis.com", path: "/v1beta/properties/123:runReport", method: "POST", times: 2, auth: ["authorization", "Bearer tok"], reply: { rows: [{ metricValues: [{ value: "100" }, { value: "80" }, { value: "5" }], dimensionValues: [{ value: "google / cpc" }] }] }, expect: { sessions: 100, users: 80, conversions: 5, conversion_rate: 0.05 } },
  { app: "outlook", action: "outlook.send", input: { to: ["a@b.com"], subject: "s", body: "b" }, creds: oauth(), origin: "https://graph.microsoft.com", path: "/v1.0/me/sendMail", method: "POST", auth: ["authorization", "Bearer tok"], reply: {}, expect: { sent: true } },
  { app: "slack", action: "slack.post_message", input: { channel: "#growth", text: "hi" }, creds: key({ botToken: "xoxb-1" }), origin: "https://slack.com", path: "/api/chat.postMessage", method: "POST", auth: ["authorization", "Bearer xoxb-1"], reply: { ok: true, ts: "1.2", channel: "C1" }, expect: { sent: true, ts: "1.2" } },
  { app: "whatsapp", action: "whatsapp.send", input: { to: ["+91 98200 11223"], text: "Hello" }, creds: key({ access_token: "EAA", phone_number_id: "555" }), origin: "https://graph.facebook.com", path: "/v21.0/555/messages", method: "POST", auth: ["authorization", "Bearer EAA"], reply: { messages: [{ id: "wamid.1" }] }, expect: { sent: 1, ids: ["wamid.1"] } },
  { app: "metaads", action: "metaads.insights", input: { range: "last_7d" }, creds: key({ access_token: "EAA", ad_account_id: "act_42" }), origin: "https://graph.facebook.com", path: /^\/v21\.0\/act_42\/insights\?.*date_preset=last_7d.*level=campaign/, auth: ["authorization", "Bearer EAA"], reply: { data: [{ campaign_name: "Diwali", spend: "1000", impressions: "10", clicks: "2", actions: [{ action_type: "purchase", value: "4" }], purchase_roas: [{ value: "3.5" }] }] }, expect: { spend: 1000, purchases: 4, roas: 3.5, cpa: 250 } },
  { app: "hubspot", action: "hubspot.deals.search", input: { range: "last_30d" }, creds: key({ token: "pat-1" }), origin: "https://api.hubapi.com", path: "/crm/v3/objects/deals/search", method: "POST", auth: ["authorization", "Bearer pat-1"], reply: { total: 1, results: [{ id: "9", properties: { dealname: "Taj", amount: "800000", dealstage: "qualified" } }] }, expect: { total: 1, pipeline_value: 800000 } },
  { app: "hubspot", action: "hubspot.deals.update", input: { deal_id: "9", changes: [{ field: "Stage", to: "proposal" }] }, creds: key({ token: "pat-1" }), origin: "https://api.hubapi.com", path: "/crm/v3/objects/deals/9", method: "PATCH", auth: ["authorization", "Bearer pat-1"], reply: { id: "9" }, expect: { id: "9", updated: ["dealstage"] } },
  { app: "salesforce", action: "salesforce.query", input: { soql: "SELECT Id FROM Opportunity" }, creds: oauth({ instanceUrl: "https://acme.my.salesforce.com" }), origin: "https://acme.my.salesforce.com", path: /^\/services\/data\/v62\.0\/query\?q=SELECT/, auth: ["authorization", "Bearer tok"], reply: { totalSize: 1, records: [{ attributes: {}, Id: "006" }] }, expect: { total: 1, records: [{ Id: "006" }] } },
  { app: "shopify", action: "shopify.orders.search", input: {}, creds: key({ shop: "kesar.myshopify.com", token: "shpat" }), origin: "https://kesar.myshopify.com", path: /^\/admin\/api\/2025-10\/orders\.json/, auth: ["x-shopify-access-token", "shpat"], reply: { orders: [] }, expect: { orders: 0, revenue: 0 } },
  { app: "razorpay", action: "razorpay.refunds.create", input: { payment_id: "pay_1", amount_inr: 6499, reason: "damaged" }, creds: key({ key_id: "rzp", key_secret: "s" }), origin: "https://api.razorpay.com", path: "/v1/payments/pay_1/refund", method: "POST", auth: ["authorization", `Basic ${Buffer.from("rzp:s").toString("base64")}`], reply: { id: "rfnd_1", status: "processed", amount: 649900 }, expect: { refund_id: "rfnd_1", amount_inr: 6499 } },
  { app: "razorpay", action: "razorpay.payments.list", input: {}, creds: key({ key_id: "rzp", key_secret: "s" }), origin: "https://api.razorpay.com", path: /^\/v1\/payments\?count=100&from=\d+$/, auth: ["authorization", /^Basic /], reply: { count: 1, items: [{ id: "pay", amount: 10000, status: "captured", method: "upi", created_at: 1700000000 }] }, expect: { captured: 1, captured_amount_inr: 100 } },
  { app: "stripe", action: "stripe.payments.list", input: {}, creds: key({ token: "sk_1" }), origin: "https://api.stripe.com", path: /^\/v1\/payment_intents\?created%5Bgte%5D=\d+&limit=100$/, auth: ["authorization", "Bearer sk_1"], reply: { data: [{ id: "pi", amount: 5000, currency: "inr", status: "succeeded", created: 1700000000 }] }, expect: { succeeded: 1, succeeded_amount: 50 } },
  { app: "stripe", action: "stripe.refunds.create", input: { payment_id: "pi_1" }, creds: key({ token: "sk_1" }), origin: "https://api.stripe.com", path: "/v1/refunds", method: "POST", auth: ["authorization", "Bearer sk_1"], reply: { id: "re_1", status: "succeeded", amount: 5000 }, expect: { refund_id: "re_1", amount: 50 } },
  { app: "delhivery", action: "delhivery.track", input: { waybill: "123" }, creds: key({ token: "dl" }), origin: "https://track.delhivery.com", path: "/api/v1/packages/json/?waybill=123", auth: ["authorization", "Token dl"], reply: { ShipmentData: [{ Shipment: { AWB: "123", Status: { Status: "In Transit", StatusLocation: "Pune", StatusDateTime: now } } }] }, expect: { shipments: [{ awb: "123", status: "In Transit", location: "Pune", updated: now, expected_delivery: undefined, destination: undefined }] } },
  { app: "zendesk", action: "zendesk.tickets.search", input: { query: "status<solved" }, creds: key({ subdomain: "kesar.zendesk.com", email: "a@b.com", token: "zd" }), origin: "https://kesar.zendesk.com", path: /^\/api\/v2\/search\.json\?query=type%3Aticket/, auth: ["authorization", `Basic ${Buffer.from("a@b.com/token:zd").toString("base64")}`], reply: { count: 1, results: [{ id: 1, subject: "Late", status: "open", priority: null, created_at: now, tags: ["delivery"] }] }, expect: { count: 1, top_tags: [{ tag: "delivery", tickets: 1 }] } },
  { app: "zendesk", action: "zendesk.tickets.create", input: { subject: "s", body: "b" }, creds: oauth({ subdomain: "kesar" }), origin: "https://kesar.zendesk.com", path: "/api/v2/tickets.json", method: "POST", auth: ["authorization", "Bearer tok"], reply: { ticket: { id: 7, status: "new" } }, expect: { ticket_id: 7 } },
  { app: "freshdesk", action: "freshdesk.tickets.search", input: {}, creds: key({ domain: "kesar.freshdesk.com", token: "fd" }), origin: "https://kesar.freshdesk.com", path: /^\/api\/v2\/search\/tickets\?query=/, auth: ["authorization", `Basic ${Buffer.from("fd:X").toString("base64")}`], reply: { total: 0, results: [] }, expect: { total: 0 } },
  { app: "intercom", action: "intercom.conversations.search", input: {}, creds: key({ token: "ic" }), origin: "https://api.intercom.io", path: "/conversations/search", method: "POST", auth: ["authorization", "Bearer ic"], reply: { total_count: 0, conversations: [] }, expect: { total: 0 } },
  { app: "mailchimp", action: "mailchimp.campaigns.list", input: {}, creds: key({ token: "abc-us21" }), origin: "https://us21.api.mailchimp.com", path: /^\/3\.0\/campaigns/, auth: ["authorization", /^Basic /], reply: { campaigns: [] }, expect: { campaigns: [] } },
  { app: "notion", action: "notion.search", input: { query: "SOP" }, creds: key({ token: "ntn" }), origin: "https://api.notion.com", path: "/v1/search", method: "POST", auth: ["notion-version", "2022-06-28"], reply: { results: [{ id: "p", object: "page", url: "u", last_edited_time: now, properties: { Name: { type: "title", title: [{ plain_text: "AP SOP" }] } } }] }, expect: { results: [{ id: "p", type: "page", url: "u", edited: now, title: "AP SOP" }] } },
  { app: "github", action: "github.issues.search", input: { query: "is:open" }, creds: key({ token: "ghp" }), origin: "https://api.github.com", path: /^\/search\/issues/, auth: ["authorization", "Bearer ghp"], reply: { total_count: 1, items: [{ number: 3, title: "Bug", state: "open", html_url: "h", repository_url: "https://api.github.com/repos/o/r", user: { login: "u" }, created_at: now }] }, expect: { total: 1, items: [{ number: 3, title: "Bug", state: "open", url: "h", repo: "o/r", author: "u", created: now, is_pr: false }] } },
  { app: "github", action: "github.issues.create", input: { owner: "o", repo: "r", title: "t" }, creds: key({ token: "ghp" }), origin: "https://api.github.com", path: "/repos/o/r/issues", method: "POST", auth: ["x-github-api-version", "2022-11-28"], reply: { number: 4, html_url: "h" }, expect: { number: 4 } },
  { app: "jira", action: "jira.issues.search", input: { jql: "project = OPS" }, creds: key({ site: "kesar.atlassian.net", email: "a@b.com", token: "j" }), origin: "https://kesar.atlassian.net", path: /^\/rest\/api\/3\/search\/jql\?/, auth: ["authorization", /^Basic /], reply: { issues: [{ key: "OPS-1", fields: { summary: "S", status: { name: "To Do" }, assignee: null, created: now } }] }, expect: { issues: [{ key: "OPS-1", summary: "S", status: "To Do", assignee: null, priority: undefined, created: now }] } },
  { app: "jira", action: "jira.issues.create", input: { project_key: "OPS", summary: "Laptop" }, creds: key({ site: "kesar.atlassian.net", email: "a@b.com", token: "j" }), origin: "https://kesar.atlassian.net", path: "/rest/api/3/issue", method: "POST", auth: ["authorization", /^Basic /], reply: { key: "OPS-2" }, expect: { key: "OPS-2", url: "https://kesar.atlassian.net/browse/OPS-2" } },
  { app: "linear", action: "linear.issues.search", input: { query: "bug" }, creds: key({ token: "lin_api_1" }), origin: "https://api.linear.app", path: "/graphql", method: "POST", auth: ["authorization", "lin_api_1"], reply: { data: { searchIssues: { nodes: [{ identifier: "ENG-1", title: "Bug", url: "u", state: { name: "Todo" } }] } } }, expect: { issues: [{ id: "ENG-1", title: "Bug", state: "Todo", url: "u" }] } },
  { app: "okta", action: "okta.users.search", input: { query: "farhan" }, creds: key({ domain: "kesar.okta.com", token: "o" }), origin: "https://kesar.okta.com", path: /^\/api\/v1\/users\?limit=25&q=farhan$/, auth: ["authorization", "SSWS o"], reply: [{ id: "u1", status: "ACTIVE", profile: { login: "f@k.in", firstName: "Farhan", lastName: "Ali" }, lastLogin: null }], expect: { users: [{ id: "u1", login: "f@k.in", name: "Farhan Ali", status: "ACTIVE", last_login: null }] } },
  { app: "gmail", action: "gmail.messages.search", input: { query: "invoice" }, creds: oauth(), origin: "https://gmail.googleapis.com", path: /^\/gmail\/v1\/users\/me\/messages\?maxResults=10&q=invoice$/, auth: ["authorization", "Bearer tok"], reply: { messages: [], resultSizeEstimate: 0 }, expect: { total: 0, messages: [] } },
];

describe("live drivers", () => {
  it("covers every registered driver", () => {
    const tested = new Set(CASES.map((c) => c.action));
    const extra = ["gsheets.values.append", "outlook.messages.search", "slack.channels.list"];
    expect(Object.keys(DRIVERS).filter((a) => !tested.has(a) && !extra.includes(a))).toEqual([]);
  });

  it.each(CASES.map((c) => [c.action, c] as const))("%s", async (_name, c) => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    let seen: Record<string, string> = {};
    mock
      .get(c.origin)
      .intercept({ path: c.path, method: c.method ?? "GET" })
      .reply((opts) => {
        seen = Object.fromEntries(Object.entries(opts.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
        return { statusCode: 200, data: JSON.stringify(c.reply), responseOptions: { headers: { "content-type": "application/json" } } };
      })
      .times(c.times ?? 1);
    const out = await runLive(c.app, c.action, c.input, { id: null, credentials: c.creds });
    expect(out).toMatchObject(c.expect);
    const [h, v] = c.auth;
    if (typeof v === "string") expect(seen[h]).toBe(v);
    else expect(seen[h]).toMatch(v);
    mock.assertNoPendingInterceptors();
  });

  it("turns provider errors into readable messages", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock.get("https://api.hubapi.com").intercept({ path: "/crm/v3/objects/deals/search", method: "POST" }).reply(400, { message: "Property values were not valid" }, { headers: { "content-type": "application/json" } });
    await expect(runLive("hubspot", "hubspot.deals.search", {}, { id: null, credentials: key({ token: "t" }) })).rejects.toThrow("hubspot API error 400: Property values were not valid");
    await expect(runLive("salesforce", "salesforce.query", { soql: "DELETE FROM X" }, { id: null, credentials: oauth({ instanceUrl: "https://x" }) })).rejects.toThrow("Only SELECT");
  });
});
