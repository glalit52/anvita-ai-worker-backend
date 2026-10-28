import { ConnectorError, type Driver } from "../types.js";
import { since } from "./google.js";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const header = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? String(v).split(/[,;]/).map((s) => s.trim()).filter(Boolean) : []);

/** GAQL date range for "last_7d", "last_30d", "last_week", "this_month"… */
function gaqlRange(range: unknown): string {
  const r = String(range ?? "last_7d").toLowerCase();
  if (/last_?week/.test(r)) return "segments.date DURING LAST_WEEK_MON_SUN";
  if (/this_?month/.test(r)) return "segments.date DURING THIS_MONTH";
  if (/last_?month/.test(r)) return "segments.date DURING LAST_MONTH";
  const start = since(r).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  return `segments.date BETWEEN '${start}' AND '${end}'`;
}

export const extraDrivers: Record<string, Driver> = {
  // ─── Google Ads ───
  "googleads.report": async (i, { call }) => {
    const r = await call<{ results?: { campaign: { name: string; status: string }; metrics: { costMicros?: string; conversions?: number; clicks?: string; impressions?: string; conversionsValue?: number } }[] }>("https://googleads.googleapis.com/v21/customers/{customer_id}/googleAds:search", {
      body: { query: `SELECT campaign.name, campaign.status, metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions, metrics.conversions_value FROM campaign WHERE ${gaqlRange(i.range)} AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 50` },
    });
    const campaigns = (r.results ?? []).map((x) => {
      const spend = Number(x.metrics.costMicros ?? 0) / 1e6;
      const conv = Number(x.metrics.conversions ?? 0);
      return { campaign: x.campaign.name, status: x.campaign.status, spend: Math.round(spend * 100) / 100, conversions: conv, clicks: Number(x.metrics.clicks ?? 0), impressions: Number(x.metrics.impressions ?? 0), revenue: Number(x.metrics.conversionsValue ?? 0), cpa: conv ? Math.round((spend / conv) * 100) / 100 : null };
    });
    const spend = campaigns.reduce((a, c) => a + c.spend, 0);
    const conversions = campaigns.reduce((a, c) => a + c.conversions, 0);
    const revenue = campaigns.reduce((a, c) => a + c.revenue, 0);
    return { range: String(i.range ?? "last_7d"), spend: Math.round(spend * 100) / 100, conversions, cpa: conversions ? Math.round((spend / conversions) * 100) / 100 : null, roas: spend ? Math.round((revenue / spend) * 100) / 100 : null, campaigns };
  },

  // ─── Google Calendar / Gmail ───
  "gcal.events.create": async (i, { call }) => {
    const tz = String(i.timezone ?? "Asia/Kolkata");
    const start = String(i.start);
    const end = String(i.end ?? new Date(Date.parse(start) + Number(i.duration_minutes ?? 30) * 60_000).toISOString());
    const r = await call<{ id: string; htmlLink: string; hangoutLink?: string }>(`https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all${i.meet === false ? "" : "&conferenceDataVersion=1"}`, {
      body: {
        summary: i.title,
        description: i.description ?? "",
        start: { dateTime: start, timeZone: tz },
        end: { dateTime: end, timeZone: tz },
        attendees: list(i.attendees).map((email) => ({ email })),
        ...(i.meet === false ? {} : { conferenceData: { createRequest: { requestId: `anvita-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } } }),
      },
    });
    return { created: true, id: r.id, link: r.htmlLink, meet: r.hangoutLink ?? null };
  },
  "gcal.freebusy": async (i, { call }) => {
    const from = new Date(String(i.from ?? new Date().toISOString()));
    const to = new Date(String(i.to ?? new Date(from.getTime() + Number(i.days ?? 5) * 86400_000).toISOString()));
    const r = await call<{ calendars: Record<string, { busy: { start: string; end: string }[] }> }>("https://www.googleapis.com/calendar/v3/freeBusy", { body: { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: "Asia/Kolkata", items: [{ id: "primary" }, ...list(i.attendees).map((id) => ({ id }))] } });
    return { from: from.toISOString(), to: to.toISOString(), busy: r.calendars };
  },
  "gmail.drafts.create": async (i, { call }) => {
    const mime = [`To: ${list(i.to).join(", ")}`, `Subject: ${header(String(i.subject ?? ""))}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", String(i.body ?? "")].join("\r\n");
    const r = await call<{ id: string; message: { id: string } }>("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { body: { message: { raw: b64url(mime) } } });
    return { drafted: true, draft_id: r.id };
  },

  // ─── Microsoft Teams ───
  "teams.channels.list": async (_i, { call }) => {
    const teams = await call<{ value: { id: string; displayName: string }[] }>("https://graph.microsoft.com/v1.0/me/joinedTeams");
    const out: { team: string; team_id: string; channel: string; channel_id: string }[] = [];
    for (const t of teams.value.slice(0, 20)) {
      const ch = await call<{ value: { id: string; displayName: string }[] }>(`https://graph.microsoft.com/v1.0/teams/${t.id}/channels`);
      for (const c of ch.value) out.push({ team: t.displayName, team_id: t.id, channel: c.displayName, channel_id: c.id });
    }
    return { channels: out };
  },
  "teams.post_message": async (i, { call }) => {
    // "Team / Channel" names or explicit ids.
    let teamId = i.team_id ? String(i.team_id) : "";
    let channelId = i.channel_id ? String(i.channel_id) : "";
    if (!teamId || !channelId) {
      const [teamName, channelName] = String(i.channel ?? "").replace(/^#/, "").split(/\s*[/›>]\s*/);
      const teams = await call<{ value: { id: string; displayName: string }[] }>("https://graph.microsoft.com/v1.0/me/joinedTeams");
      const team = teams.value.find((t) => t.displayName.toLowerCase() === (channelName ? teamName : "").toLowerCase()) ?? (channelName ? undefined : teams.value[0]);
      if (!team) throw new ConnectorError(`Teams: team "${teamName}" not found — use "Team / Channel"`);
      const chans = await call<{ value: { id: string; displayName: string }[] }>(`https://graph.microsoft.com/v1.0/teams/${team.id}/channels`);
      const want = (channelName ?? teamName ?? "General").toLowerCase();
      const ch = chans.value.find((c) => c.displayName.toLowerCase() === want) ?? chans.value.find((c) => c.displayName === "General");
      if (!ch) throw new ConnectorError(`Teams: channel "${want}" not found in ${team.displayName}`);
      teamId = team.id;
      channelId = ch.id;
    }
    const r = await call<{ id: string; webUrl?: string }>(`https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`, { body: { body: { contentType: "text", content: String(i.text) } } });
    return { sent: true, id: r.id, url: r.webUrl ?? null };
  },

  // ─── Okta ───
  "okta.users.reset_password": async (i, { call }) => {
    const user = await call<{ id: string; profile: { login: string } }>(`https://{domain}/api/v1/users/${encodeURIComponent(String(i.user))}`);
    const r = await call<{ resetPasswordUrl?: string }>(`https://{domain}/api/v1/users/${user.id}/lifecycle/reset_password?sendEmail=${i.send_email === false ? "false" : "true"}`, { method: "POST" });
    return { reset: true, user: user.profile.login, emailed: i.send_email !== false, link: i.send_email === false ? (r.resetPasswordUrl ?? null) : null };
  },
  "okta.groups.add_user": async (i, { call }) => {
    const user = await call<{ id: string; profile: { login: string } }>(`https://{domain}/api/v1/users/${encodeURIComponent(String(i.user))}`);
    const groups = await call<{ id: string; profile: { name: string } }[]>(`https://{domain}/api/v1/groups?q=${encodeURIComponent(String(i.group))}&limit=5`);
    const g = groups.find((x) => x.profile.name.toLowerCase() === String(i.group).toLowerCase()) ?? groups[0];
    if (!g) throw new ConnectorError(`Okta group "${i.group}" not found`);
    await call(`https://{domain}/api/v1/groups/${g.id}/users/${user.id}`, { method: "PUT" });
    return { added: true, user: user.profile.login, group: g.profile.name };
  },

  // ─── Shopify ───
  "shopify.orders.get": async (i, { call }) => {
    const ref = String(i.order ?? i.order_id ?? i.name ?? "").trim();
    if (!ref) throw new ConnectorError("Give an order number (e.g. #1042) or id");
    const fields = "id,name,email,phone,created_at,financial_status,fulfillment_status,cancelled_at,total_price,currency,line_items,shipping_address,fulfillments,gateway,tags";
    type Order = { id: number; name: string; email?: string; phone?: string; created_at: string; financial_status: string; fulfillment_status: string | null; cancelled_at: string | null; total_price: string; currency: string; gateway?: string; tags?: string; line_items: { title: string; quantity: number; price: string }[]; shipping_address?: { name?: string; city?: string; province?: string; zip?: string }; fulfillments?: { tracking_company?: string; tracking_number?: string; tracking_url?: string; shipment_status?: string }[] };
    const r = /^\d{8,}$/.test(ref) ? { orders: [(await call<{ order: Order }>(`https://{shop}/admin/api/2025-10/orders/${ref}.json?fields=${fields}`)).order] } : await call<{ orders: Order[] }>(`https://{shop}/admin/api/2025-10/orders.json?status=any&name=${encodeURIComponent(ref.startsWith("#") ? ref : `#${ref}`)}&fields=${fields}`);
    const o = r.orders[0];
    if (!o) return { found: false, order: ref };
    const f = o.fulfillments?.[0];
    return { found: true, id: o.id, order: o.name, created_at: o.created_at, payment: o.financial_status, gateway: o.gateway ?? null, fulfillment: o.fulfillment_status ?? "unfulfilled", cancelled: !!o.cancelled_at, total: Number(o.total_price), currency: o.currency, items: o.line_items.map((l) => ({ title: l.title, qty: l.quantity, price: Number(l.price) })), ship_to: o.shipping_address ? { name: o.shipping_address.name, city: o.shipping_address.city, state: o.shipping_address.province, pincode: o.shipping_address.zip } : null, tracking: f ? { courier: f.tracking_company ?? null, awb: f.tracking_number ?? null, url: f.tracking_url ?? null, status: f.shipment_status ?? null } : null, customer: { email: o.email ?? null, phone: o.phone ?? null }, tags: o.tags ?? "" };
  },
  "shopify.products.search": async (i, { call }) => {
    const r = await call<{ products: { id: number; title: string; status: string; variants: { id: number; title: string; sku: string; price: string; inventory_quantity: number }[] }[] }>(`https://{shop}/admin/api/2025-10/products.json?limit=250&fields=id,title,status,variants${i.query ? `&title=${encodeURIComponent(String(i.query))}` : ""}`);
    const threshold = i.low_stock_below != null ? Number(i.low_stock_below) : null;
    const variants = r.products.flatMap((p) => p.variants.map((v) => ({ product: p.title, variant: v.title === "Default Title" ? null : v.title, sku: v.sku, price: Number(v.price), stock: v.inventory_quantity, status: p.status })));
    const rows = threshold == null ? variants : variants.filter((v) => v.stock < threshold);
    return { total: rows.length, ...(threshold != null ? { low_stock_below: threshold } : {}), variants: rows.slice(0, 300) };
  },
  "shopify.customers.search": async (i, { call }) => {
    const r = await call<{ customers: { id: number; first_name: string; last_name: string; email: string; phone: string; orders_count: number; total_spent: string; tags: string }[] }>(`https://{shop}/admin/api/2025-10/customers/search.json?limit=50&query=${encodeURIComponent(String(i.query ?? ""))}`);
    return { total: r.customers.length, customers: r.customers.map((c) => ({ id: c.id, name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(), email: c.email, phone: c.phone, orders: c.orders_count, total_spent: Number(c.total_spent), tags: c.tags })) };
  },

  // ─── HubSpot contacts ───
  "hubspot.contacts.search": async (i, { call }) => {
    const filters = i.range ? [{ propertyName: "createdate", operator: "GTE", value: String(since(i.range, 7).getTime()) }] : [];
    const r = await call<{ total: number; results: { id: string; properties: Record<string, string | null> }[] }>("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      body: { filterGroups: filters.length ? [{ filters }] : [], ...(i.query ? { query: String(i.query) } : {}), properties: ["firstname", "lastname", "email", "company", "jobtitle", "lifecyclestage", "hs_lead_status", "createdate", "website", "phone"], sorts: [{ propertyName: "createdate", direction: "DESCENDING" }], limit: Math.min(Number(i.limit ?? 50), 100) },
    });
    return { total: r.total, contacts: r.results.map((c) => ({ id: c.id, name: `${c.properties.firstname ?? ""} ${c.properties.lastname ?? ""}`.trim(), email: c.properties.email, company: c.properties.company, title: c.properties.jobtitle, stage: c.properties.lifecyclestage, lead_status: c.properties.hs_lead_status, website: c.properties.website, phone: c.properties.phone, created: c.properties.createdate })) };
  },
  "hubspot.contacts.update": async (i, { call }) => {
    const r = await call<{ id: string }>(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(String(i.contact_id))}`, { method: "PATCH", body: { properties: i.properties ?? {} } });
    return { id: r.id, updated: Object.keys((i.properties as object) ?? {}) };
  },

  // ─── Zendesk ───
  "zendesk.tickets.update": async (i, { call }) => {
    const ticket: Record<string, unknown> = {};
    if (i.status) ticket.status = i.status;
    if (i.priority) ticket.priority = i.priority;
    if (i.tags) ticket.tags = list(i.tags);
    if (i.comment) ticket.comment = { body: String(i.comment), public: i.public !== false };
    const r = await call<{ ticket: { id: number; status: string } }>(`https://{subdomain}.zendesk.com/api/v2/tickets/${encodeURIComponent(String(i.ticket_id))}.json`, { method: "PUT", body: { ticket } });
    return { id: r.ticket.id, status: r.ticket.status };
  },

  // ─── Razorpay ───
  "razorpay.payment_links.create": async (i, { call }) => {
    const r = await call<{ id: string; short_url: string; status: string; amount: number }>("https://api.razorpay.com/v1/payment_links", {
      body: {
        amount: Math.round(Number(i.amount_inr) * 100),
        currency: "INR",
        description: i.description ?? "Payment",
        reference_id: i.reference ?? undefined,
        customer: { name: i.customer_name ?? undefined, contact: i.phone ?? undefined, email: i.email ?? undefined },
        notify: { sms: !!i.notify, email: !!i.notify },
        reminder_enable: true,
        upi_link: i.upi === true,
        ...(i.expire_days ? { expire_by: Math.floor(Date.now() / 1000) + Number(i.expire_days) * 86400 } : {}),
      },
    });
    return { id: r.id, url: r.short_url, status: r.status, amount_inr: r.amount / 100 };
  },

  // ─── WhatsApp templates (needed outside the 24h customer-service window) ───
  "whatsapp.send_template": async (i, { call }) => {
    const ids: string[] = [];
    for (const to of list(i.to)) {
      const r = await call<{ messages: { id: string }[] }>("https://graph.facebook.com/v21.0/{phone_number_id}/messages", {
        body: { messaging_product: "whatsapp", to: to.replace(/[^\d]/g, ""), type: "template", template: { name: String(i.template), language: { code: String(i.language ?? "en") }, components: list(i.params).length ? [{ type: "body", parameters: list(i.params).map((text) => ({ type: "text", text })) }] : [] } },
      });
      ids.push(r.messages[0]?.id);
    }
    return { sent: ids.length, ids };
  },
};
