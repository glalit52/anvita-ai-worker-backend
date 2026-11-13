import { desc, eq, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { config } from "../config.js";
import { db, type Tx } from "../db/client.js";
import { invoices, workspaces } from "../db/schema.js";
import { newId } from "../lib/ids.js";

/**
 * GST tax invoices. Buyers in the seller's state pay CGST + SGST; other Indian states pay IGST;
 * buyers outside India are zero-rated (export of services). Numbers run per Indian financial year:
 * ANV/2026-27/000123.
 */

export type Invoice = typeof invoices.$inferSelect;

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export interface BillingProfile {
  legalName: string;
  gstin: string;
  address: string;
  stateCode: string;
  country: string;
  email: string;
}

export async function billingProfile(workspaceId: string, tx: Tx = db): Promise<BillingProfile> {
  const [ws] = await tx.select({ name: workspaces.name, settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const s = (ws?.settings ?? {}) as Record<string, unknown>;
  const gstin = String(s["billing.gstin"] ?? "").toUpperCase();
  return {
    legalName: String(s["billing.legalName"] ?? ws?.name ?? ""),
    gstin,
    address: String(s["billing.address"] ?? ""),
    stateCode: String(s["billing.stateCode"] ?? (gstin ? gstin.slice(0, 2) : "")),
    country: String(s["billing.country"] ?? "IN"),
    email: String(s["billing.email"] ?? ""),
  };
}

export function taxSplit(subtotal: number, buyer: BillingProfile) {
  const round = (n: number) => Math.round(n * 100) / 100;
  if (buyer.country && buyer.country !== "IN") return { cgst: 0, sgst: 0, igst: 0, total: round(subtotal) };
  const tax = subtotal * config.BILLING_TAX_RATE;
  if (buyer.stateCode && buyer.stateCode === config.SELLER_STATE_CODE) {
    const half = round(tax / 2);
    return { cgst: half, sgst: half, igst: 0, total: round(subtotal + half * 2) };
  }
  return { cgst: 0, sgst: 0, igst: round(tax), total: round(subtotal + round(tax)) };
}

function financialYear(d: Date) {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/** Issue an invoice. `providerRef` (payment id) makes repeated webhook deliveries create it once. */
export async function issueInvoice(
  input: { workspaceId: string; kind: "subscription" | "credits"; description: string; subtotal: number; status: "paid" | "due"; providerRef?: string | null; periodStart?: Date; periodEnd?: Date; dueDays?: number },
  tx: Tx = db,
): Promise<Invoice> {
  if (input.providerRef) {
    const [existing] = await tx.select().from(invoices).where(eq(invoices.providerRef, input.providerRef));
    if (existing) return existing;
  }
  const buyer = await billingProfile(input.workspaceId, tx);
  const tax = taxSplit(input.subtotal, buyer);
  const [{ n }] = (await tx.execute(sql`select nextval('invoice_number_seq')::int as n`)) as unknown as { n: number }[];
  const now = new Date();
  const [row] = await tx
    .insert(invoices)
    .values({
      id: newId("inv"),
      workspaceId: input.workspaceId,
      number: `ANV/${financialYear(now)}/${String(n).padStart(6, "0")}`,
      kind: input.kind,
      status: input.status,
      currency: config.BILLING_CURRENCY.toUpperCase(),
      subtotal: Math.round(input.subtotal * 100) / 100,
      ...tax,
      lines: [{ description: input.description, sac: config.INVOICE_SAC, quantity: 1, amount: Math.round(input.subtotal * 100) / 100 }],
      seller: { name: config.SELLER_NAME, gstin: config.SELLER_GSTIN, address: config.SELLER_ADDRESS, stateCode: config.SELLER_STATE_CODE },
      buyer: { ...buyer },
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      providerRef: input.providerRef ?? null,
      issuedAt: now,
      dueAt: input.status === "due" ? new Date(now.getTime() + (input.dueDays ?? 15) * 86400_000) : null,
      paidAt: input.status === "paid" ? now : null,
    })
    .returning();
  return row;
}

export const listInvoices = (workspaceId: string) => db.select().from(invoices).where(eq(invoices.workspaceId, workspaceId)).orderBy(desc(invoices.issuedAt)).limit(200);

export function serializeInvoice(i: Invoice) {
  return { id: i.id, number: i.number, kind: i.kind, status: i.status, currency: i.currency, subtotal: i.subtotal, cgst: i.cgst, sgst: i.sgst, igst: i.igst, total: i.total, description: i.lines[0]?.description ?? "", issuedAt: i.issuedAt.toISOString(), dueAt: i.dueAt?.toISOString() ?? null, paidAt: i.paidAt?.toISOString() ?? null, periodStart: i.periodStart?.toISOString() ?? null, periodEnd: i.periodEnd?.toISOString() ?? null };
}

const money = (n: number, cur: string) => `${cur === "INR" ? "Rs." : cur} ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");

/** Render the invoice as a PDF. */
export function invoicePdf(i: Invoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Tax invoice ${i.number}`, Author: i.seller.name } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).font("Helvetica-Bold").text(i.status === "paid" ? "TAX INVOICE" : "TAX INVOICE (PAYMENT DUE)", { align: "right" });
    doc.moveDown(0.3).fontSize(10).font("Helvetica").text(`Invoice no. ${i.number}`, { align: "right" }).text(`Date ${date(i.issuedAt)}`, { align: "right" });
    if (i.dueAt) doc.text(`Due ${date(i.dueAt)}`, { align: "right" });

    const top = 140;
    doc.font("Helvetica-Bold").fontSize(10).text("From", 50, top).font("Helvetica").text(i.seller.name).text(i.seller.address);
    if (i.seller.gstin) doc.text(`GSTIN ${i.seller.gstin}`);
    doc.text(`State code ${i.seller.stateCode}`);
    doc.font("Helvetica-Bold").text("Bill to", 320, top).font("Helvetica").text(i.buyer.legalName || "—", 320).text(i.buyer.address || "", 320);
    if (i.buyer.gstin) doc.text(`GSTIN ${i.buyer.gstin}`, 320);
    if (i.buyer.stateCode) doc.text(`Place of supply: state code ${i.buyer.stateCode}`, 320);
    else if (i.buyer.country && i.buyer.country !== "IN") doc.text(`Export of services (${i.buyer.country})`, 320);

    let y = 280;
    doc.font("Helvetica-Bold").text("Description", 50, y).text("SAC", 330, y).text("Amount", 420, y, { width: 125, align: "right" });
    doc.moveTo(50, y + 15).lineTo(545, y + 15).stroke("#cccccc");
    y += 25;
    doc.font("Helvetica");
    for (const l of i.lines) {
      doc.text(l.description, 50, y, { width: 270 }).text(l.sac, 330, y).text(money(l.amount, i.currency), 420, y, { width: 125, align: "right" });
      y += 30;
    }
    if (i.periodStart && i.periodEnd) {
      doc.fontSize(9).fillColor("#666666").text(`Service period ${date(i.periodStart)} to ${date(i.periodEnd)}`, 50, y - 12).fillColor("#000000").fontSize(10);
      y += 10;
    }
    doc.moveTo(50, y).lineTo(545, y).stroke("#cccccc");
    y += 12;
    const row = (label: string, value: number, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").text(label, 300, y, { width: 115 }).text(money(value, i.currency), 420, y, { width: 125, align: "right" });
      y += 18;
    };
    row("Taxable value", i.subtotal);
    const rate = config.BILLING_TAX_RATE * 100;
    if (i.cgst) row(`CGST @ ${rate / 2}%`, i.cgst);
    if (i.sgst) row(`SGST @ ${rate / 2}%`, i.sgst);
    if (i.igst) row(`IGST @ ${rate}%`, i.igst);
    row("Total", i.total, true);
    doc.font("Helvetica").fontSize(9).fillColor("#666666").text(i.status === "paid" ? `Paid on ${date(i.paidAt)}. Thank you.` : "Please pay by the due date from Settings → Billing.", 50, y + 20).text("This is a computer-generated invoice and does not require a signature.", 50, y + 34);
    doc.end();
  });
}
