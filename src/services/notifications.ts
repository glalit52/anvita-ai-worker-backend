import { and, eq } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { memberships, notifications } from "../db/schema.js";
import type { Role } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { roleAtLeast } from "./rbac.js";
import { publish } from "./events.js";

export interface NotifyInput {
  workspaceId: string;
  appId: string;
  title: string;
  meta?: string;
  href?: string;
  /** Explicit recipients; otherwise every active member whose role is at least `minRole`. */
  userIds?: string[];
  minRole?: Role;
}

export async function notify(input: NotifyInput, tx: Tx = db): Promise<void> {
  let userIds = input.userIds;
  if (!userIds) {
    const ms = await tx.select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.status, "active")));
    userIds = ms.filter((m) => m.userId && roleAtLeast(m.role, input.minRole ?? "viewer")).map((m) => m.userId!);
  }
  for (const userId of new Set(userIds)) {
    const row = { id: newId("ntf"), workspaceId: input.workspaceId, userId, appId: input.appId, title: input.title, meta: input.meta ?? "", href: input.href ?? "/", read: false, createdAt: new Date() };
    await tx.insert(notifications).values(row);
    await publish({ workspaceId: input.workspaceId, userId, type: "notification.created", data: row }, tx);
  }
}
