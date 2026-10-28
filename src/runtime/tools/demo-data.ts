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
    case "shopify.orders.get":
      return { ...base, found: true, order: String(input.order ?? input.order_id ?? "#1042"), payment: "paid", fulfillment: pick(["fulfilled", "unfulfilled", "partial"]), total: n(600, 6000), currency: "INR", items: [{ title: pick(PRODUCTS), qty: n(1, 3), price: n(300, 2000) }], tracking: { courier: "Delhivery", awb: `14${n(10_000_000, 99_999_999)}`, status: pick(["in_transit", "out_for_delivery", "delivered"]) }, ship_to: { city: pick(CITIES) } };
    case "shopify.products.search":
      return { ...base, total: 4, variants: PRODUCTS.slice(0, 4).map((p) => ({ product: p, sku: `KF-${n(100, 999)}`, price: n(250, 2500), stock: n(0, 40) })) };
    case "shopify.customers.search":
      return { ...base, total: 1, customers: [{ id: n(1000, 9999), name: "Meera Iyer", email: "meera@example.com", orders: n(1, 12), total_spent: n(2000, 40_000) }] };
    case "hubspot.contacts.search":
      return { ...base, total: 3, contacts: ["Ananya Rao", "Vikram Shah", "Sara Thomas"].map((name, i) => ({ id: `c_${200 + i}`, name, email: `${name.split(" ")[0].toLowerCase()}@${pick(COMPANIES).toLowerCase().replace(/\s/g, "")}.com`, company: pick(COMPANIES), title: pick(["Head of Procurement", "Admin Manager", "HR Lead"]), stage: "lead" })) };
    case "tally.ledgers.list":
      return { ...base, total: 3, ledgers: [{ name: "Sharma Packaging Pvt Ltd", group: "Sundry Creditors", closing_balance: -n(50_000, 300_000) }, { name: "Purchase @18%", group: "Purchase Accounts", closing_balance: n(500_000, 2_000_000) }, { name: "Input IGST", group: "Duties & Taxes", closing_balance: n(50_000, 200_000) }] };
    case "tally.vouchers.create":
    case "quickbooks.bills.create":
      return { ...base, created: true, voucher_id: `V${n(1000, 9999)}` };
    case "quickbooks.query":
    case "zoho.records.search":
    case "postgres.query":
    case "bigquery.query":
      return { ...base, total: 3, rows: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, name: pick(COMPANIES), amount: n(10_000, 200_000) })) };
    case "zoho.books.invoices.list":
      return { ...base, total: 3, outstanding: n(100_000, 600_000), invoices: Array.from({ length: 3 }, (_, i) => ({ number: `INV-${2400 + i}`, customer: pick(COMPANIES), status: "overdue", due_date: `2026-10-${String(n(1, 20)).padStart(2, "0")}`, balance: n(20_000, 200_000) })) };
    case "darwinbox.employees.search":
    case "workday.workers.search":
      return { ...base, total: 2, employees: [{ employee_id: "KF1042", name: "Arjun Nair", email: "arjun@kesarfoods.in", department: "Sales", date_of_joining: "2026-11-03" }, { employee_id: "KF1043", name: "Divya Menon", email: "divya@kesarfoods.in", department: "Finance", date_of_joining: "2026-11-03" }] };
    case "teams.channels.list":
      return { ...base, channels: [{ team: "Kesar Foods", channel: "General" }, { team: "Kesar Foods", channel: "Finance" }] };
    case "razorpay.payment_links.create":
      return { ...base, id: `plink_${Math.floor(r() * 1e10).toString(36)}`, url: "https://rzp.io/i/demo", status: "created", amount_inr: Number(input.amount_inr ?? 0) };
    case "gcal.events.create":
      return { ...base, created: true, id: `evt_${n(1000, 9999)}`, meet: "https://meet.google.com/demo-link" };
    case "gcal.freebusy":
      return { ...base, busy: { primary: { busy: [{ start: "2026-10-29T10:00:00+05:30", end: "2026-10-29T11:00:00+05:30" }] } } };
    case "okta.users.reset_password":
    case "okta.groups.add_user":
    case "zendesk.tickets.update":
    case "hubspot.contacts.update":
    case "gmail.drafts.create":
    case "teams.post_message":
    case "whatsapp.send_template":
      return { ...base, ok: true, done: true };
    default:
      return { ...base, ok: true };
  }
}
