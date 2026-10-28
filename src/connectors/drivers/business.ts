import type { Driver } from "../types.js";
import { since } from "./google.js";

const inr = (paise: number) => Math.round(paise) / 100;

export const businessDrivers: Record<string, Driver> = {
  // ─── HubSpot ───
  "hubspot.deals.search": async (i, { call }) => {
    const filters = [{ propertyName: "createdate", operator: "GTE", value: String(since(i.range, 30).getTime()) }];
    const r = await call<{ total: number; results: { id: string; properties: Record<string, string | null> }[] }>("https://api.hubapi.com/crm/v3/objects/deals/search", {
      body: { filterGroups: [{ filters }], ...(i.query ? { query: String(i.query) } : {}), properties: ["dealname", "amount", "dealstage", "closedate", "pipeline", "createdate"], sorts: [{ propertyName: "createdate", direction: "DESCENDING" }], limit: 50 },
    });
    const deals = r.results.map((d) => ({ id: d.id, name: d.properties.dealname, amount: Number(d.properties.amount ?? 0), stage: d.properties.dealstage, close_date: d.properties.closedate, created: d.properties.createdate }));
    return { total: r.total, pipeline_value: deals.reduce((a, d) => a + d.amount, 0), deals };
  },
  "hubspot.deals.update": async (i, { call }) => {
    const props: Record<string, string> = {};
    const map: Record<string, string> = { stage: "dealstage", amount: "amount", "close date": "closedate", name: "dealname" };
    for (const c of i.changes as { field: string; to: string }[]) props[map[c.field.toLowerCase()] ?? c.field] = c.to;
    const r = await call<{ id: string }>(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(String(i.deal_id))}`, { method: "PATCH", body: { properties: props } });
    return { id: r.id, updated: Object.keys(props) };
  },
  "salesforce.query": async (i, { call, get }) => {
    const base = get("instanceUrl");
    if (!base) throw new Error("Salesforce instance URL missing — reconnect Salesforce");
    const soql = String(i.soql);
    if (!/^\s*select\b/i.test(soql)) throw new Error("Only SELECT queries are allowed");
    const r = await call<{ totalSize: number; records: Record<string, unknown>[] }>(`${base}/services/data/v62.0/query?q=${encodeURIComponent(soql)}`);
    return { total: r.totalSize, records: r.records.slice(0, 200).map(({ attributes: _a, ...rest }) => rest) };
  },

  // ─── Shopify ───
  "shopify.orders.search": async (i, { call }) => {
    const r = await call<{ orders: { id: number; name: string; total_price: string; created_at: string; financial_status: string; fulfillment_status: string | null; cancelled_at: string | null; shipping_address?: { province?: string; city?: string }; line_items: { title: string; quantity: number }[]; gateway?: string }[] }>(
      `https://{shop}/admin/api/2025-10/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since(i.range).toISOString())}&fields=id,name,total_price,created_at,financial_status,fulfillment_status,cancelled_at,shipping_address,line_items,gateway`,
    );
    const orders = r.orders;
    const count = (f: (o: (typeof orders)[number]) => string | undefined) => Object.entries(orders.reduce<Record<string, number>>((acc, o) => ((acc[f(o) ?? "Unknown"] = (acc[f(o) ?? "Unknown"] ?? 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const products: Record<string, number> = {};
    for (const o of orders) for (const li of o.line_items) products[li.title] = (products[li.title] ?? 0) + li.quantity;
    return {
      since: since(i.range).toISOString().slice(0, 10),
      orders: orders.length,
      revenue: Math.round(orders.reduce((a, o) => a + Number(o.total_price), 0)),
      cancelled: orders.filter((o) => o.cancelled_at).length,
      cod_orders: orders.filter((o) => /cod|cash/i.test(o.gateway ?? "")).length,
      by_state: count((o) => o.shipping_address?.province),
      top_products: Object.entries(products).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([product, units]) => ({ product, units })),
      recent: orders.slice(0, 10).map((o) => ({ order: o.name, total: o.total_price, status: o.financial_status, fulfillment: o.fulfillment_status })),
    };
  },

  // ─── Payments ───
  "razorpay.refunds.create": async (i, { call }) => {
    const r = await call<{ id: string; status: string; amount: number }>(`https://api.razorpay.com/v1/payments/${encodeURIComponent(String(i.payment_id))}/refund`, { body: { amount: Math.round(Number(i.amount_inr) * 100), notes: { reason: String(i.reason ?? "").slice(0, 250) } } });
    return { refund_id: r.id, status: r.status, amount_inr: inr(r.amount) };
  },
  "razorpay.payments.list": async (i, { call }) => {
    const from = Math.floor(since(i.range).getTime() / 1000);
    const r = await call<{ count: number; items: { id: string; amount: number; status: string; method: string; email?: string; contact?: string; created_at: number }[] }>(`https://api.razorpay.com/v1/payments?count=100&from=${from}`);
    const captured = r.items.filter((p) => p.status === "captured");
    return { count: r.count, captured: captured.length, captured_amount_inr: inr(captured.reduce((a, p) => a + p.amount, 0)), failed: r.items.filter((p) => p.status === "failed").length, payments: r.items.slice(0, 20).map((p) => ({ id: p.id, amount_inr: inr(p.amount), status: p.status, method: p.method, created: new Date(p.created_at * 1000).toISOString() })) };
  },
  "stripe.payments.list": async (i, { call }) => {
    const r = await call<{ data: { id: string; amount: number; currency: string; status: string; created: number; description?: string }[] }>(`https://api.stripe.com/v1/payment_intents?limit=100&created[gte]=${Math.floor(since(i.range).getTime() / 1000)}`);
    const ok = r.data.filter((p) => p.status === "succeeded");
    return { count: r.data.length, succeeded: ok.length, succeeded_amount: ok.reduce((a, p) => a + p.amount, 0) / 100, payments: r.data.slice(0, 20).map((p) => ({ id: p.id, amount: p.amount / 100, currency: p.currency, status: p.status, created: new Date(p.created * 1000).toISOString() })) };
  },
  "stripe.refunds.create": async (i, { call }) => {
    const r = await call<{ id: string; status: string; amount: number }>("https://api.stripe.com/v1/refunds", { form: { payment_intent: String(i.payment_id), ...(i.amount ? { amount: String(Math.round(Number(i.amount) * 100)) } : {}), reason: "requested_by_customer" } });
    return { refund_id: r.id, status: r.status, amount: r.amount / 100 };
  },
  "delhivery.track": async (i, { call }) => {
    const r = await call<{ ShipmentData?: { Shipment: { AWB: string; Status: { Status: string; StatusLocation: string; StatusDateTime: string }; ExpectedDeliveryDate?: string; Destination?: string } }[] }>(`https://track.delhivery.com/api/v1/packages/json/?waybill=${encodeURIComponent(String(i.waybill))}`);
    return { shipments: (r.ShipmentData ?? []).map(({ Shipment: s }) => ({ awb: s.AWB, status: s.Status.Status, location: s.Status.StatusLocation, updated: s.Status.StatusDateTime, expected_delivery: s.ExpectedDeliveryDate, destination: s.Destination })) };
  },

  // ─── Support ───
  "zendesk.tickets.search": async (i, { call }) => {
    const q = `type:ticket ${String(i.query ?? "status<solved")}`;
    const r = await call<{ count: number; results: { id: number; subject: string; status: string; priority: string | null; created_at: string; tags: string[] }[] }>(`https://{subdomain}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(q)}&sort_by=created_at&sort_order=desc`);
    const tags: Record<string, number> = {};
    for (const t of r.results) for (const tag of t.tags) tags[tag] = (tags[tag] ?? 0) + 1;
    return { count: r.count, top_tags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag, n]) => ({ tag, tickets: n })), tickets: r.results.slice(0, 25).map((t) => ({ id: t.id, subject: t.subject, status: t.status, priority: t.priority, created: t.created_at })) };
  },
  "zendesk.tickets.create": async (i, { call }) => {
    const r = await call<{ ticket: { id: number; status: string } }>("https://{subdomain}.zendesk.com/api/v2/tickets.json", { body: { ticket: { subject: i.subject, comment: { body: i.body }, ...(i.requester_email ? { requester: { email: i.requester_email, name: i.requester_name ?? i.requester_email } } : {}) } } });
    return { ticket_id: r.ticket.id, status: r.ticket.status };
  },
  "freshdesk.tickets.search": async (i, { call }) => {
    const r = await call<{ total: number; results: { id: number; subject: string; status: number; priority: number; created_at: string }[] }>(`https://{domain}/api/v2/search/tickets?query=${encodeURIComponent(`"${String(i.query ?? "status:2")}"`)}`);
    return { total: r.total, tickets: r.results.slice(0, 25) };
  },
  "intercom.conversations.search": async (i, { call }) => {
    const r = await call<{ total_count: number; conversations: { id: string; title?: string; state: string; created_at: number }[] }>("https://api.intercom.io/conversations/search", { body: { query: { field: "state", operator: "=", value: String(i.state ?? "open") }, pagination: { per_page: 25 } } });
    return { total: r.total_count, conversations: r.conversations.map((c) => ({ id: c.id, title: c.title, state: c.state, created: new Date(c.created_at * 1000).toISOString() })) };
  },
};
