import type { Driver } from "../types.js";

export const otherDrivers: Record<string, Driver> = {
  // ─── Messaging ───
  "slack.post_message": async (i, { call }) => {
    const r = await call<{ ok: boolean; error?: string; ts: string; channel: string }>("https://slack.com/api/chat.postMessage", { body: { channel: String(i.channel).replace(/^#/, ""), text: String(i.text), ...(i.thread_ts ? { thread_ts: i.thread_ts } : {}) } });
    if (!r.ok) throw new Error(`Slack: ${r.error}`);
    return { sent: true, ts: r.ts, channel: r.channel };
  },
  "slack.channels.list": async (_i, { call }) => {
    const r = await call<{ ok: boolean; error?: string; channels: { id: string; name: string; num_members: number; is_member: boolean }[] }>("https://slack.com/api/conversations.list?limit=200&exclude_archived=true&types=public_channel");
    if (!r.ok) throw new Error(`Slack: ${r.error}`);
    return { channels: r.channels.map((c) => ({ id: c.id, name: `#${c.name}`, members: c.num_members, bot_is_member: c.is_member })) };
  },
  "whatsapp.send": async (i, { call }) => {
    const ids: string[] = [];
    for (const to of i.to as string[]) {
      const r = await call<{ messages: { id: string }[] }>("https://graph.facebook.com/v21.0/{phone_number_id}/messages", { body: { messaging_product: "whatsapp", recipient_type: "individual", to: to.replace(/[^\d]/g, ""), type: "text", text: { preview_url: false, body: String(i.text) } } });
      ids.push(r.messages[0]?.id);
    }
    return { sent: ids.length, ids };
  },
  "metaads.insights": async (i, { call }) => {
    const preset = /30|month/.test(String(i.range ?? "")) ? "last_30d" : /14/.test(String(i.range ?? "")) ? "last_14d" : "last_7d";
    const r = await call<{ data: { campaign_name: string; spend: string; impressions: string; clicks: string; actions?: { action_type: string; value: string }[]; purchase_roas?: { value: string }[] }[] }>(
      `https://graph.facebook.com/v21.0/act_{ad_account_id}/insights?level=campaign&date_preset=${preset}&fields=campaign_name,spend,impressions,clicks,actions,purchase_roas&limit=50`,
    );
    const campaigns = r.data.map((c) => {
      const purchases = Number(c.actions?.find((a) => a.action_type === "purchase")?.value ?? 0);
      const spend = Number(c.spend);
      return { campaign: c.campaign_name, spend, impressions: Number(c.impressions), clicks: Number(c.clicks), purchases, roas: Number(c.purchase_roas?.[0]?.value ?? 0), cpa: purchases ? Math.round(spend / purchases) : null };
    });
    const spend = campaigns.reduce((a, c) => a + c.spend, 0);
    const purchases = campaigns.reduce((a, c) => a + c.purchases, 0);
    const value = campaigns.reduce((a, c) => a + c.roas * c.spend, 0);
    return { range: preset, spend: Math.round(spend), purchases, roas: spend ? Number((value / spend).toFixed(2)) : 0, cpa: purchases ? Math.round(spend / purchases) : null, campaigns };
  },
  "mailchimp.campaigns.list": async (_i, { call, get }) => {
    const dc = String(get("token") ?? "").split("-")[1];
    if (!dc) throw new Error("Mailchimp API key should end with the data center, e.g. -us21");
    const r = await call<{ campaigns: { id: string; settings: { title: string; subject_line: string }; send_time: string; report_summary?: { open_rate: number; click_rate: number; opens: number } }[] }>(`https://${dc}.api.mailchimp.com/3.0/campaigns?count=20&sort_field=send_time&sort_dir=DESC&status=sent`);
    return { campaigns: r.campaigns.map((c) => ({ title: c.settings.title, subject: c.settings.subject_line, sent: c.send_time, open_rate: c.report_summary?.open_rate, click_rate: c.report_summary?.click_rate })) };
  },

  // ─── Knowledge & engineering ───
  "notion.search": async (i, { call }) => {
    const r = await call<{ results: { id: string; object: string; url: string; last_edited_time: string; properties?: Record<string, { type: string; title?: { plain_text: string }[] }> }[] }>("https://api.notion.com/v1/search", { body: { query: String(i.query ?? ""), page_size: 15 } });
    return {
      results: r.results.map((p) => ({
        id: p.id,
        type: p.object,
        url: p.url,
        edited: p.last_edited_time,
        title: Object.values(p.properties ?? {}).find((v) => v.type === "title")?.title?.map((t) => t.plain_text).join("") ?? "(untitled)",
      })),
    };
  },
  "github.issues.search": async (i, { call }) => {
    const r = await call<{ total_count: number; items: { number: number; title: string; state: string; html_url: string; repository_url: string; user: { login: string }; created_at: string; pull_request?: unknown }[] }>(`https://api.github.com/search/issues?per_page=25&q=${encodeURIComponent(String(i.query))}`);
    return { total: r.total_count, items: r.items.map((x) => ({ number: x.number, title: x.title, state: x.state, url: x.html_url, repo: x.repository_url.split("/repos/")[1], author: x.user.login, created: x.created_at, is_pr: !!x.pull_request })) };
  },
  "github.issues.create": async (i, { call }) => {
    const r = await call<{ number: number; html_url: string }>(`https://api.github.com/repos/${encodeURIComponent(String(i.owner))}/${encodeURIComponent(String(i.repo))}/issues`, { body: { title: i.title, body: i.body, labels: i.labels } });
    return { number: r.number, url: r.html_url };
  },
  "jira.issues.search": async (i, { call }) => {
    const r = await call<{ issues: { key: string; fields: { summary: string; status: { name: string }; assignee?: { displayName: string } | null; priority?: { name: string }; created: string } }[] }>(`https://{site}/rest/api/3/search/jql?maxResults=25&fields=summary,status,assignee,priority,created&jql=${encodeURIComponent(String(i.jql ?? "order by created DESC"))}`);
    return { issues: r.issues.map((x) => ({ key: x.key, summary: x.fields.summary, status: x.fields.status.name, assignee: x.fields.assignee?.displayName ?? null, priority: x.fields.priority?.name, created: x.fields.created })) };
  },
  "jira.issues.create": async (i, { call, get }) => {
    const r = await call<{ key: string }>("https://{site}/rest/api/3/issue", {
      body: { fields: { project: { key: String(i.project_key) }, summary: String(i.summary), issuetype: { name: String(i.issue_type ?? "Task") }, description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: String(i.description ?? "") }] }] } } },
    });
    return { key: r.key, url: `https://${String(get("site")).replace(/^https?:\/\//, "")}/browse/${r.key}` };
  },
  "linear.issues.search": async (i, { call }) => {
    const r = await call<{ data?: { issueSearch?: { nodes: { identifier: string; title: string; state: { name: string }; url: string }[] }; searchIssues?: { nodes: { identifier: string; title: string; state: { name: string }; url: string }[] } }; errors?: { message: string }[] }>("https://api.linear.app/graphql", {
      body: { query: "query($q: String!) { searchIssues(term: $q, first: 25) { nodes { identifier title url state { name } } } }", variables: { q: String(i.query ?? "") } },
    });
    if (r.errors?.length) throw new Error(`Linear: ${r.errors[0].message}`);
    return { issues: (r.data?.searchIssues ?? r.data?.issueSearch)?.nodes.map((n) => ({ id: n.identifier, title: n.title, state: n.state.name, url: n.url })) ?? [] };
  },
  "okta.users.search": async (i, { call }) => {
    const r = await call<{ id: string; status: string; profile: { login: string; firstName: string; lastName: string }; lastLogin: string | null }[]>(`https://{domain}/api/v1/users?limit=25&q=${encodeURIComponent(String(i.query ?? ""))}`);
    return { users: r.map((u) => ({ id: u.id, login: u.profile.login, name: `${u.profile.firstName} ${u.profile.lastName}`, status: u.status, last_login: u.lastLogin })) };
  },
};
