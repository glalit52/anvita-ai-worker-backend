import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db, type Tx } from "../db/client.js";
import { connections, memberships, policies, workspaces } from "../db/schema.js";
import { newId, randomString, slugify } from "../lib/ids.js";
import { audit } from "./audit.js";
import { grant } from "./credits.js";

/** Policies every new workspace starts with (safe defaults from the product spec). */
export const DEFAULT_POLICIES = [
  { name: "External email needs owner approval", appliesTo: "gmail.send, outlook.send", condition: "external_recipients > 0", effect: "approve" as const, approvers: "Owner", priority: 10 },
  { name: "Refunds above ₹5,000", appliesTo: "razorpay.refunds.create, stripe.refunds.create", condition: "amount > 5000", effect: "approve" as const, approvers: "Admin", priority: 20 },
  { name: "Never delete records", appliesTo: "*.delete", condition: "always", effect: "deny" as const, approvers: null, priority: 5 },
  { name: "CRM writes by Workers", appliesTo: "hubspot.*.update, salesforce.*.update", condition: "actor == worker", effect: "approve" as const, approvers: "Builder", priority: 30 },
  { name: "Bulk WhatsApp sends", appliesTo: "whatsapp.send", condition: "recipients > 500", effect: "approve" as const, approvers: "Owner", priority: 40 },
  { name: "Read-only actions", appliesTo: "*.read, *.search, *.list, *.insights, *.report, *.export", condition: "always", effect: "allow" as const, approvers: null, priority: 100 },
];

export async function createWorkspace(tx: Tx, input: { name: string; owner: { userId: string; name: string; email: string }; domains?: string[] }) {
  const id = newId("ws");
  const domain = input.owner.email.split("@")[1]?.toLowerCase();
  const consumer = ["gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "icloud.com", "proton.me"];
  const domains = input.domains ?? (domain && !consumer.includes(domain) ? [domain] : []);
  await tx.insert(workspaces).values({ id, name: input.name, slug: `${slugify(input.name)}-${randomString(4)}`, domains, renewsAt: new Date(Date.now() + 30 * 86400_000) });
  await tx.insert(memberships).values({ id: newId("mem"), workspaceId: id, userId: input.owner.userId, email: input.owner.email, name: input.owner.name, role: "owner", status: "active", lastActiveAt: new Date() });
  await tx.insert(policies).values(DEFAULT_POLICIES.map((p) => ({ ...p, id: newId("pol"), workspaceId: id })));
  await tx.insert(connections).values(["web", "sandbox"].map((appId) => ({ id: newId("con"), workspaceId: id, appId, scope: "workspace" as const, connectedByName: "System" })));
  await grant(id, config.DEFAULT_PLAN_CREDITS, "plan_grant", { plan: "Business" }, tx);
  await audit({ workspaceId: id, actor: input.owner.name, actorId: input.owner.userId, action: "workspace.created", target: input.name }, tx);
  return id;
}

export async function getWorkspace(id: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return ws;
}
