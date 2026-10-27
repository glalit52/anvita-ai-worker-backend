import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { memberships, workspaces } from "../db/schema.js";
import { sha256 } from "../lib/crypto.js";
import { assertFound, badRequest, conflict, forbidden } from "../lib/errors.js";
import { newId, randomString } from "../lib/ids.js";
import { auth } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { getBalance } from "../services/credits.js";
import { sendEmail } from "../services/email.js";
import { roleAtLeast } from "../services/rbac.js";
import { serializeMember } from "../services/serializers.js";

const role = z.enum(["owner", "admin", "builder", "member", "viewer"]);

export const workspaceRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ["workspace"];

  app.get("/workspace", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => {
    const a = auth(req);
    const ws = assertFound((await db.select().from(workspaces).where(eq(workspaces.id, a.workspaceId)))[0], "Workspace");
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, ws.id));
    return { id: ws.id, name: ws.name, slug: ws.slug, plan: ws.plan, region: ws.region, domains: ws.domains, renewsOn: ws.renewsAt?.toISOString() ?? null, members: n, installedPacks: ws.installedPacks, role: a.role, ...(await getBalance(ws.id)) };
  });

  app.patch("/workspace", { preHandler: app.authorize("workspace:manage"), schema: { tags, body: z.object({ name: z.string().trim().min(1).max(100).optional(), region: z.string().max(64).optional(), domains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(20).optional() }) } }, async (req) => {
    const a = auth(req);
    const [ws] = await db.update(workspaces).set(req.body).where(eq(workspaces.id, a.workspaceId)).returning();
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "workspace.updated", target: Object.keys(req.body).join(", "), ip: req.ip });
    return { id: ws.id, name: ws.name, region: ws.region, domains: ws.domains };
  });

  /** Free-form workspace settings (the web app's `useSetting` keys). */
  app.get("/workspace/settings", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => {
    const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, auth(req).workspaceId));
    return ws?.settings ?? {};
  });

  app.patch("/workspace/settings", { preHandler: app.authorize("workspace:manage"), schema: { tags, body: z.record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean()])) } }, async (req) => {
    const a = auth(req);
    const [ws] = await db.update(workspaces).set({ settings: sql`${workspaces.settings} || ${JSON.stringify(req.body)}::jsonb` }).where(eq(workspaces.id, a.workspaceId)).returning({ settings: workspaces.settings });
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "settings.updated", target: Object.keys(req.body).join(", "), ip: req.ip });
    return ws.settings;
  });

  // ─── Members ───

  app.get("/members", { preHandler: app.authorize("workspace:read"), schema: { tags } }, async (req) => {
    const rows = await db.select().from(memberships).where(eq(memberships.workspaceId, auth(req).workspaceId)).orderBy(asc(memberships.createdAt));
    return { data: rows.map(serializeMember) };
  });

  app.post("/members", { preHandler: app.authorize("members:manage"), schema: { tags, body: z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().toLowerCase().email(), role }) } }, async (req, reply) => {
    const a = auth(req);
    if (req.body.role === "owner" && a.role !== "owner") throw forbidden("Only owners can invite owners");
    const [dup] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.workspaceId, a.workspaceId), sql`lower(${memberships.email}) = ${req.body.email}`));
    if (dup) throw conflict("This person is already a member or invited");
    const token = `inv_${randomString(40)}`;
    const [m] = await db.insert(memberships).values({ id: newId("mem"), workspaceId: a.workspaceId, email: req.body.email, name: req.body.name, role: req.body.role, status: "invited", inviteTokenHash: sha256(token), invitedBy: a.userId }).returning();
    const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, a.workspaceId));
    const link = `${config.WEB_URL}/invite/${token}`;
    const sent = await sendEmail({ to: req.body.email, subject: `${a.userName} invited you to ${ws?.name} on Anvita`, text: `${a.userName} invited you to join ${ws?.name} on Anvita AI as ${req.body.role}.\n\nAccept the invite: ${link}\n\nThis link expires in 14 days.` }, req.log).catch((e) => {
      req.log.warn({ err: e }, "invite email failed");
      return false;
    });
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "member.invited", target: `${req.body.email} as ${req.body.role}`, ip: req.ip });
    // The link is returned so admins can share it manually when email isn't configured.
    return reply.status(201).send({ ...serializeMember(m), inviteLink: link, emailSent: sent });
  });

  app.patch("/members/:id", { preHandler: app.authorize("members:manage"), schema: { tags, params: z.object({ id: z.string() }), body: z.object({ role: role.optional(), name: z.string().trim().min(1).max(100).optional() }) } }, async (req) => {
    const a = auth(req);
    const m = assertFound((await db.select().from(memberships).where(and(eq(memberships.id, req.params.id), eq(memberships.workspaceId, a.workspaceId))))[0], "Member");
    if (req.body.role) {
      if ((req.body.role === "owner" || m.role === "owner") && a.role !== "owner") throw forbidden("Only owners can grant or remove the owner role");
      if (m.role === "owner" && req.body.role !== "owner") await assertAnotherOwner(a.workspaceId, m.id);
    }
    const [u] = await db.update(memberships).set(req.body).where(eq(memberships.id, m.id)).returning();
    if (req.body.role && req.body.role !== m.role) await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "member.role_changed", target: `${m.email} → ${req.body.role}`, ip: req.ip });
    return serializeMember(u);
  });

  app.delete("/members/:id", { preHandler: app.authorize("members:manage"), schema: { tags, params: z.object({ id: z.string() }) } }, async (req, reply) => {
    const a = auth(req);
    const m = assertFound((await db.select().from(memberships).where(and(eq(memberships.id, req.params.id), eq(memberships.workspaceId, a.workspaceId))))[0], "Member");
    if (m.role === "owner") {
      if (a.role !== "owner") throw forbidden("Only owners can remove an owner");
      await assertAnotherOwner(a.workspaceId, m.id);
    }
    if (!roleAtLeast(a.role, m.role)) throw forbidden("You can't remove someone with a higher role");
    await db.delete(memberships).where(eq(memberships.id, m.id));
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "member.removed", target: m.email, ip: req.ip });
    return reply.status(204).send();
  });
};

async function assertAnotherOwner(workspaceId: string, exceptMembershipId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "owner"), eq(memberships.status, "active"), ne(memberships.id, exceptMembershipId)));
  if (n < 1) throw badRequest("A workspace needs at least one owner");
}
