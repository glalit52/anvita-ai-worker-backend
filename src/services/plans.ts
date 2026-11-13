import { and, count, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections, memberships, subscriptions, workers } from "../db/schema.js";
import { AppError } from "../lib/errors.js";

/**
 * Plans: monthly credits, limits and features. Prices are in INR before GST; yearly billing is
 * ten months' price (two months free). Enterprise is priced by sales and invoiced manually.
 */

export type PlanId = "starter" | "growth" | "business" | "enterprise";
export type Feature = "customApis" | "mcp" | "piiRedaction" | "dataRetention" | "saml" | "scim" | "ipAllowlist" | "auditExport" | "dedicatedSupport";

export interface Plan {
  id: PlanId;
  name: string;
  description: string;
  /** Monthly price (INR, before GST); null = contact sales. */
  price: number | null;
  credits: number;
  limits: { members: number | null; workers: number | null; connections: number | null };
  features: Feature[];
}

const GROWTH: Feature[] = ["customApis", "mcp", "piiRedaction", "dataRetention"];
const BUSINESS: Feature[] = [...GROWTH, "saml", "scim", "ipAllowlist", "auditExport"];

export const PLANS: Plan[] = [
  { id: "starter", name: "Starter", description: "Try Anvita with a small team", price: 0, credits: 2_000, limits: { members: 3, workers: 3, connections: 5 }, features: [] },
  { id: "growth", name: "Growth", description: "For teams automating their first workflows", price: 4_999, credits: 50_000, limits: { members: 15, workers: 25, connections: 25 }, features: GROWTH },
  { id: "business", name: "Business", description: "Company-wide AI Workers with SSO and governance", price: 19_999, credits: 250_000, limits: { members: 100, workers: null, connections: null }, features: BUSINESS },
  { id: "enterprise", name: "Enterprise", description: "Unlimited scale, dedicated support and custom terms", price: null, credits: 1_000_000, limits: { members: null, workers: null, connections: null }, features: [...BUSINESS, "dedicatedSupport"] },
];
export const planById = Object.fromEntries(PLANS.map((p) => [p.id, p])) as Record<PlanId, Plan>;
export const FEATURE_LABEL: Record<Feature, string> = {
  customApis: "Custom APIs (OpenAPI import)",
  mcp: "MCP servers",
  piiRedaction: "PII redaction",
  dataRetention: "Data retention controls",
  saml: "SAML single sign-on",
  scim: "SCIM provisioning",
  ipAllowlist: "IP allowlist",
  auditExport: "Audit log export",
  dedicatedSupport: "Dedicated support",
};

/** Price for one billing period (before tax). */
export const periodPrice = (plan: Plan, interval: "month" | "year") => (plan.price ?? 0) * (interval === "year" ? 10 : 1);

export async function currentPlan(workspaceId: string): Promise<Plan> {
  const [s] = await db.select({ plan: subscriptions.plan }).from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  return planById[(s?.plan ?? "starter") as PlanId] ?? planById.starter;
}

const upgradeTo = (test: (p: Plan) => boolean) => PLANS.find((p) => test(p))?.name ?? "Enterprise";

export async function assertFeature(workspaceId: string, feature: Feature) {
  const plan = await currentPlan(workspaceId);
  if (plan.features.includes(feature)) return;
  const needed = upgradeTo((p) => p.features.includes(feature));
  throw new AppError(402, "plan_limit", `${FEATURE_LABEL[feature]} is available on the ${needed} plan — upgrade in Settings → Billing`, { feature, plan: plan.id, upgradeTo: needed });
}

export async function usage(workspaceId: string) {
  const [[m], [w], [c]] = await Promise.all([
    db.select({ n: count() }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.status, ["active", "invited"]))),
    db.select({ n: count() }).from(workers).where(eq(workers.workspaceId, workspaceId)),
    db.select({ n: count() }).from(connections).where(and(eq(connections.workspaceId, workspaceId), notInArray(connections.appId, ["web", "sandbox"]))),
  ]);
  return { members: m.n, workers: w.n, connections: c.n };
}

/** Before adding one more member / Worker / connection. */
export async function assertLimit(workspaceId: string, what: "members" | "workers" | "connections") {
  const plan = await currentPlan(workspaceId);
  const limit = plan.limits[what];
  if (limit === null) return;
  const used = (await usage(workspaceId))[what];
  if (used < limit) return;
  const needed = upgradeTo((p) => p.limits[what] === null || (p.limits[what] ?? 0) > limit);
  throw new AppError(402, "plan_limit", `Your ${plan.name} plan includes ${limit} ${what} — upgrade to ${needed} for more`, { limit: what, max: limit, plan: plan.id, upgradeTo: needed });
}
