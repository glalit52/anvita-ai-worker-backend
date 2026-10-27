import { and, eq, gte, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { creditLedger } from "../db/schema.js";
import { paymentRequired } from "../lib/errors.js";

export interface Balance { creditsTotal: number; creditsUsed: number; remaining: number }

export async function getBalance(workspaceId: string, tx: Tx = db): Promise<Balance> {
  const [row] = await tx
    .select({
      granted: sql<number>`coalesce(sum(case when ${creditLedger.delta} > 0 then ${creditLedger.delta} else 0 end), 0)::int`,
      used: sql<number>`coalesce(-sum(case when ${creditLedger.delta} < 0 then ${creditLedger.delta} else 0 end), 0)::int`,
    })
    .from(creditLedger)
    .where(eq(creditLedger.workspaceId, workspaceId));
  const creditsTotal = Number(row?.granted ?? 0);
  const creditsUsed = Number(row?.used ?? 0);
  return { creditsTotal, creditsUsed, remaining: creditsTotal - creditsUsed };
}

export async function grant(workspaceId: string, credits: number, reason: "plan_grant" | "topup" | "adjustment" | "refund", meta?: Record<string, unknown>, tx: Tx = db) {
  await tx.insert(creditLedger).values({ workspaceId, delta: Math.round(credits), reason, meta: meta ?? null });
}

/** Record usage. Usage is always recorded (work already happened); quota is enforced before work starts. */
export async function charge(workspaceId: string, credits: number, ref: { type: string; id: string }, meta?: Record<string, unknown>, tx: Tx = db) {
  if (credits <= 0) return;
  await tx.insert(creditLedger).values({ workspaceId, delta: -Math.round(credits), reason: "usage", refType: ref.type, refId: ref.id, meta: meta ?? null });
}

export async function assertCredits(workspaceId: string, needed = 1) {
  const b = await getBalance(workspaceId);
  if (b.remaining < needed) throw paymentRequired(`This workspace is out of credits (${b.remaining} left). Top up in Settings → Billing.`);
}

export async function usageByDay(workspaceId: string, days = 30) {
  const since = new Date(Date.now() - days * 86400_000);
  return db
    .select({ day: sql<string>`to_char(date_trunc('day', ${creditLedger.createdAt}), 'YYYY-MM-DD')`, credits: sql<number>`(-sum(${creditLedger.delta}))::int` })
    .from(creditLedger)
    .where(and(eq(creditLedger.workspaceId, workspaceId), eq(creditLedger.reason, "usage"), gte(creditLedger.createdAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
}

/** Credits per 1M tokens (1 credit = $0.001). Unknown models fall back to the act tier price. */
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4000, out: 20000 },
  "claude-sonnet-5-5": { in: 2000, out: 10000 },
  "claude-haiku-5-5": { in: 100, out: 500 },
  scripted: { in: 2000, out: 10000 },
};

export function tokenCredits(model: string, usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES["claude-sonnet-5-5"];
  const input = (usage.input_tokens ?? 0) + 1.25 * (usage.cache_creation_input_tokens ?? 0) + 0.1 * (usage.cache_read_input_tokens ?? 0);
  return Math.max(1, Math.ceil((input * p.in + (usage.output_tokens ?? 0) * p.out) / 1_000_000));
}
