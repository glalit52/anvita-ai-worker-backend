import { XMLParser } from "fast-xml-parser";
import { qbBase } from "../providers.js";
import { ConnectorError, type Caller, type Driver } from "../types.js";

// ─── Tally Prime (XML over HTTP) ───────────────────────────────────────────────

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, trimValues: true, isArray: (name) => ["TALLYMESSAGE", "VOUCHER", "ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST", "LEDGER", "COMPANY"].includes(name) });
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const text = (v: unknown): string => (v == null ? "" : typeof v === "object" ? String((v as Record<string, unknown>)["#text"] ?? "") : String(v));
const num = (v: unknown) => Number(text(v).replace(/[^\d.-]/g, "")) || 0;

/** "2026-10" → 1–31 Oct 2026; "last_30d" → the last 30 days; "2026-10-01..2026-10-15" → that range. */
function period(p: unknown): { from: string; to: string } {
  const s = String(p ?? "").trim();
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const range = /^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to)\s*(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (range) return { from: range[1].replace(/-/g, ""), to: range[2].replace(/-/g, "") };
  const month = /^(\d{4})-(\d{2})$/.exec(s);
  if (month) {
    const last = new Date(Date.UTC(Number(month[1]), Number(month[2]), 0));
    return { from: `${month[1]}${month[2]}01`, to: ymd(last) };
  }
  const days = Number(/(\d+)\s*d/.exec(s)?.[1] ?? 30);
  return { from: ymd(new Date(Date.now() - days * 86400_000)), to: ymd(new Date()) };
}

async function tally(call: Caller, body: string) {
  const raw = await call<string>("{url}", { method: "POST", raw: `<ENVELOPE>${body}</ENVELOPE>`, headers: { Accept: "text/xml" } });
  if (typeof raw !== "string") throw new ConnectorError("Tally returned an unexpected response");
  const doc = xml.parse(raw);
  const err = doc?.RESPONSE?.LINEERROR ?? doc?.ENVELOPE?.BODY?.DATA?.LINEERROR;
  if (err) throw new ConnectorError(`Tally: ${text(err)}`);
  return doc;
}

const company = (get: (k: string) => string | undefined) => (get("company") ? `<SVCURRENTCOMPANY>${esc(get("company"))}</SVCURRENTCOMPANY>` : "");

export const financeDrivers: Record<string, Driver> = {
  "tally.vouchers.export": async (i, { call, get }) => {
    const { from, to } = period(i.period);
    const doc = await tally(call, `<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Day Book</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${company(get)}<SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${to}</SVTODATE></STATICVARIABLES></DESC></BODY>`);
    const msgs = doc?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE ?? doc?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE ?? [];
    const vouchers = (msgs as Record<string, unknown>[]).flatMap((m) => (m.VOUCHER as Record<string, unknown>[] | undefined) ?? []).map((v) => {
      const entries = ((v["ALLLEDGERENTRIES.LIST"] ?? v["LEDGERENTRIES.LIST"] ?? []) as Record<string, unknown>[]).map((e) => ({ ledger: text(e.LEDGERNAME), amount: num(e.AMOUNT) }));
      const gst = entries.filter((e) => /gst|cgst|sgst|igst|cess/i.test(e.ledger)).reduce((a, e) => a + Math.abs(e.amount), 0);
      return { type: text(v.VOUCHERTYPENAME) || text(v["@VCHTYPE"]), number: text(v.VOUCHERNUMBER), date: text(v.DATE).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"), party: text(v.PARTYLEDGERNAME), narration: text(v.NARRATION), amount: Math.max(0, ...entries.map((e) => Math.abs(e.amount))), gst, entries };
    });
    const byType: Record<string, { count: number; amount: number }> = {};
    for (const v of vouchers) {
      byType[v.type] ??= { count: 0, amount: 0 };
      byType[v.type].count++;
      byType[v.type].amount += v.amount;
    }
    return { period: { from, to }, vouchers: vouchers.length, by_type: byType, gst_total: vouchers.reduce((a, v) => a + v.gst, 0), items: vouchers.slice(0, 300) };
  },
  "tally.ledgers.list": async (i, { call, get }) => {
    const doc = await tally(call, `<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>AnvitaLedgers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${company(get)}</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="AnvitaLedgers"><TYPE>Ledger</TYPE><FETCH>NAME,PARENT,CLOSINGBALANCE,PARTYGSTIN</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY>`);
    const ledgers = ((doc?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER ?? []) as Record<string, unknown>[]).map((l) => ({ name: text(l["@NAME"]) || text(l.NAME), group: text(l.PARENT), closing_balance: num(l.CLOSINGBALANCE), gstin: text(l.PARTYGSTIN) || undefined }));
    const q = String(i.query ?? "").toLowerCase();
    const filtered = q ? ledgers.filter((l) => l.name.toLowerCase().includes(q) || l.group.toLowerCase().includes(q)) : ledgers;
    return { total: filtered.length, ledgers: filtered.slice(0, 300) };
  },
  "tally.vouchers.create": async (i, { call, get }) => {
    const type = String(i.voucher_type ?? "Purchase");
    const date = String(i.date ?? new Date().toISOString().slice(0, 10)).replace(/-/g, "");
    const entries = (i.entries as { ledger: string; amount: number; debit?: boolean }[] | undefined) ?? [];
    if (!entries.length) throw new ConnectorError("Add at least the party and one ledger entry");
    const debit = entries.filter((e) => e.debit).reduce((a, e) => a + Math.abs(e.amount), 0);
    const credit = entries.filter((e) => !e.debit).reduce((a, e) => a + Math.abs(e.amount), 0);
    if (Math.abs(debit - credit) > 0.01) throw new ConnectorError(`Debits (${debit}) and credits (${credit}) must balance`);
    // Tally's sign convention: debits are negative with ISDEEMEDPOSITIVE=Yes.
    const lines = entries.map((e) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(e.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${e.debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${(e.debit ? -1 : 1) * Math.abs(Number(e.amount))}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("");
    const doc = await tally(
      call,
      `<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES>${company(get)}</STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${esc(type)}" ACTION="Create"><DATE>${esc(date)}</DATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME>${i.number ? `<VOUCHERNUMBER>${esc(i.number)}</VOUCHERNUMBER>` : ""}${i.party ? `<PARTYLEDGERNAME>${esc(i.party)}</PARTYLEDGERNAME>` : ""}<NARRATION>${esc(i.narration ?? "Posted by Anvita")}</NARRATION>${lines}</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY>`,
    );
    const r = doc?.RESPONSE ?? doc?.ENVELOPE?.BODY?.DATA?.IMPORTRESULT ?? {};
    if (num(r.ERRORS) > 0 || num(r.CREATED) < 1) throw new ConnectorError(`Tally didn't create the voucher (errors: ${text(r.ERRORS) || "unknown"})`);
    return { created: true, voucher_id: text(r.LASTVCHID) || null, type, amount: debit };
  },

  // ─── QuickBooks Online ───
  "quickbooks.query": async (i, { call }) => {
    const q = String(i.query ?? "").trim();
    if (!/^select\b/i.test(q)) throw new ConnectorError("Only SELECT queries are allowed, e.g. SELECT * FROM Invoice WHERE Balance > '0'");
    const r = await call<{ QueryResponse: Record<string, unknown> }>(`${qbBase()}/v3/company/{realmId}/query?query=${encodeURIComponent(q)}&minorversion=75`);
    const entity = Object.keys(r.QueryResponse).find((k) => Array.isArray(r.QueryResponse[k]));
    const rows = entity ? (r.QueryResponse[entity] as unknown[]) : [];
    return { entity: entity ?? null, total: rows.length, rows: rows.slice(0, 200) };
  },
  "quickbooks.bills.create": async (i, { call }) => {
    const body = {
      VendorRef: { value: String(i.vendor_id) },
      TxnDate: i.date ?? undefined,
      DocNumber: i.number ?? undefined,
      PrivateNote: i.memo ?? "Posted by Anvita",
      Line: ((i.lines as { amount: number; account_id: string; description?: string }[] | undefined) ?? [{ amount: Number(i.amount), account_id: String(i.account_id), description: i.memo as string | undefined }]).map((l) => ({ DetailType: "AccountBasedExpenseLineDetail", Amount: Number(l.amount), Description: l.description, AccountBasedExpenseLineDetail: { AccountRef: { value: String(l.account_id) } } })),
    };
    const r = await call<{ Bill: { Id: string; TotalAmt: number; DocNumber?: string } }>(`${qbBase()}/v3/company/{realmId}/bill?minorversion=75`, { body });
    return { created: true, bill_id: r.Bill.Id, total: r.Bill.TotalAmt, number: r.Bill.DocNumber ?? null };
  },

  // ─── Zoho CRM + Books ───
  "zoho.records.search": async (i, { call }) => {
    const module = String(i.module ?? "Leads");
    const params = new URLSearchParams({ per_page: String(Math.min(Number(i.limit ?? 50), 200)) });
    if (i.criteria) params.set("criteria", String(i.criteria));
    else if (i.email) params.set("email", String(i.email));
    else params.set("word", String(i.query ?? "*"));
    const r = await call<{ data?: Record<string, unknown>[]; info?: { count: number; more_records: boolean } } | string>(`{apiDomain}/crm/v6/${encodeURIComponent(module)}/search?${params}`);
    const data = typeof r === "string" ? [] : (r.data ?? []); // 204 → no matches
    return { module, total: data.length, more: typeof r === "string" ? false : !!r.info?.more_records, records: data.map(({ $approval: _a, $process_flow: _p, ...rest }) => rest).slice(0, 200) };
  },
  "zoho.records.create": async (i, { call }) => {
    const module = String(i.module ?? "Leads");
    const r = await call<{ data: { code: string; status: string; message: string; details: { id: string } }[] }>(`{apiDomain}/crm/v6/${encodeURIComponent(module)}`, { body: { data: [i.record ?? {}], trigger: ["workflow"] } });
    const d = r.data[0];
    if (d?.status !== "success") throw new ConnectorError(`Zoho: ${d?.message ?? "create failed"}`);
    return { created: true, module, id: d.details.id };
  },
  "zoho.books.invoices.list": async (i, { call, get }) => {
    let org = String(i.organization_id ?? get("organization_id") ?? "");
    if (!org) {
      const orgs = await call<{ organizations: { organization_id: string; is_default_org: boolean }[] }>("{apiDomain}/books/v3/organizations");
      org = (orgs.organizations.find((o) => o.is_default_org) ?? orgs.organizations[0])?.organization_id ?? "";
      if (!org) throw new ConnectorError("No Zoho Books organization found");
    }
    const params = new URLSearchParams({ organization_id: org, per_page: "200", ...(i.status ? { status: String(i.status) } : {}), ...(i.customer ? { customer_name_contains: String(i.customer) } : {}) });
    const r = await call<{ invoices: { invoice_id: string; invoice_number: string; customer_name: string; status: string; date: string; due_date: string; total: number; balance: number; currency_code: string }[] }>(`{apiDomain}/books/v3/invoices?${params}`);
    const invoices = r.invoices.map((x) => ({ id: x.invoice_id, number: x.invoice_number, customer: x.customer_name, status: x.status, date: x.date, due_date: x.due_date, total: x.total, balance: x.balance, currency: x.currency_code }));
    return { total: invoices.length, outstanding: invoices.reduce((a, x) => a + x.balance, 0), invoices };
  },
};
