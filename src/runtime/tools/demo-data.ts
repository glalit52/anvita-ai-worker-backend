import { createHash } from "node:crypto";

/**
 * Deterministic sample data used by the demo connector driver, so the product is fully usable
 * (and testable) before real OAuth apps are configured. Every response is flagged `demo: true`
 * so the model and UI never mistake it for customer data.
 */

function rng(seed: string) {
  let h = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 10_000) / 10_000;
  };
}

const CITIES = ["Mumbai", "Bengaluru", "Chennai", "Delhi", "Hyderabad", "Pune", "Kolkata", "Ahmedabad"];
const PRODUCTS = ["Kaju Katli 500g", "Soan Papdi 250g", "Diwali Gift Hamper", "Kesar Pista Barfi", "Dry Fruit Box", "Motichoor Ladoo 1kg"];
const COMPANIES = ["Taj Hotels", "Infosys", "Tata Consumer", "Zomato", "Swiggy", "HDFC Bank", "Reliance Retail", "Nykaa"];

export function demoData(action: string, input: Record<string, unknown>): Record<string, unknown> {
  const r = rng(`${action}:${JSON.stringify(input)}`);
  const n = (min: number, max: number) => Math.round(min + r() * (max - min));
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const base = { demo: true, note: "Sample data from the demo connector — connect a live account for real data." };
  switch (action) {
    case "hubspot.deals.search":
      return { ...base, total: n(18, 60), deals: Array.from({ length: 6 }, (_, i) => ({ id: `deal_${1000 + i}`, name: `${pick(COMPANIES)} — corporate gifting`, stage: pick(["Qualified", "Proposal sent", "Negotiation", "Closed won"]), amount_inr: n(80_000, 1_200_000), close_date: `2026-11-${String(n(1, 28)).padStart(2, "0")}` })) };
    case "shopify.orders.search":
      return { ...base, orders_last_7d: n(900, 2400), revenue_inr: n(1_200_000, 4_800_000), rto_rate: Number((r() * 0.12).toFixed(3)), top_cities: CITIES.slice(0, 4).map((c) => ({ city: c, orders: n(80, 600) })), top_products: PRODUCTS.slice(0, 4).map((p) => ({ product: p, units: n(40, 900) })) };
    case "metaads.insights":
      return { ...base, range: input.range ?? "last_7d", spend_inr: n(300_000, 900_000), roas: Number((2 + r() * 2).toFixed(2)), cpa_inr: n(300, 520), campaigns: ["Diwali Gifting", "Retargeting", "Prospecting"].map((c) => ({ campaign: c, spend_inr: n(50_000, 300_000), roas: Number((1.5 + r() * 3).toFixed(2)) })) };
    case "googleads.report":
      return { ...base, spend_inr: n(100_000, 400_000), conversions: n(200, 900), cpa_inr: n(350, 700) };
    case "ga4.report":
      return { ...base, sessions: n(40_000, 160_000), conversion_rate: Number((0.01 + r() * 0.03).toFixed(4)), top_sources: ["google / cpc", "instagram / paid", "direct", "whatsapp"].map((s) => ({ source: s, sessions: n(2_000, 40_000) })) };
    case "zendesk.tickets.search":
      return { ...base, open: n(20, 140), csat: Number((4 + r() * 0.9).toFixed(2)), top_reasons: ["Where is my order", "Damaged item", "Refund status", "Change address"].map((x) => ({ reason: x, count: n(5, 80) })) };
    case "zendesk.tickets.create":
      return { ...base, ticket_id: n(40_000, 49_999), status: "open" };
    case "tally.vouchers.export":
      return { ...base, vouchers: n(120, 600), gst_payable_inr: n(200_000, 900_000), mismatches: n(0, 9) };
    case "gcal.events.list":
      return { ...base, events: Array.from({ length: 4 }, (_, i) => ({ title: pick(["Sales sync", "Vendor call", "Diwali planning", "1:1"]), start: `2026-10-${28 + (i % 3)}T${String(9 + i * 2).padStart(2, "0")}:00:00+05:30` })) };
    case "hubspot.deals.update":
      return { ...base, id: input.deal_id ?? "deal_1000", updated: true };
    case "razorpay.refunds.create":
      return { ...base, refund_id: `rfnd_${Math.floor(r() * 1e10).toString(36)}`, status: "processed" };
    case "gmail.send":
    case "whatsapp.send":
    case "slack.post_message":
      return { ...base, sent: true, id: `msg_${Math.floor(r() * 1e10).toString(36)}` };
    default:
      return { ...base, ok: true };
  }
}
