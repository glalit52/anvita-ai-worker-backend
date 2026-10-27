import type { Role } from "../db/schema.js";

const RANK: Record<Role, number> = { viewer: 0, member: 1, builder: 2, admin: 3, owner: 4 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/** Minimum role per permission. Keep in one place so the API and docs agree. */
export const PERMISSIONS = {
  "workspace:read": "viewer",
  "chat:write": "member",
  "approvals:decide": "member",
  "inbox:write": "member",
  "knowledge:write": "builder",
  "memory:write": "member",
  "workers:write": "builder",
  "workers:run": "member",
  "connections:write": "builder",
  "members:manage": "admin",
  "policies:manage": "admin",
  "developers:manage": "admin",
  "audit:read": "admin",
  "billing:manage": "admin",
  "workspace:manage": "admin",
} as const satisfies Record<string, Role>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, perm: Permission): boolean {
  return roleAtLeast(role, PERMISSIONS[perm]);
}

/** Map the free-text "approvers" of a policy (e.g. "Owner", "Support lead", "Finance + Owner") to the minimum role allowed to decide. */
export function approverRole(approvers: string | null | undefined): Role {
  const a = (approvers ?? "").toLowerCase();
  if (a.includes("owner")) return "owner";
  if (a.includes("admin")) return "admin";
  if (a.includes("lead") || a.includes("finance") || a.includes("builder")) return "builder";
  return "member";
}
