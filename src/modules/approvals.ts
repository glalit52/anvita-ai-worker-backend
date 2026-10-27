import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { approvals } from "../db/schema.js";
import { assertFound, conflict, forbidden } from "../lib/errors.js";
import { enqueue } from "../jobs/queue.js";
import { auth } from "../plugins/auth.js";
import { toolByName } from "../runtime/tools/index.js";
import { audit } from "../services/audit.js";
import { publish } from "../services/events.js";
import { roleAtLeast } from "../services/rbac.js";
import { serializeApproval } from "../services/serializers.js";
import { emitWebhook } from "../services/webhooks.js";

export const approvalRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ["approvals"];

  app.get("/approvals", { preHandler: app.authorize("workspace:read"), schema: { tags, querystring: z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) } }, async (req) => {
    const a = auth(req);
    const conds = [eq(approvals.workspaceId, a.workspaceId)];
    if (req.query.status) conds.push(inArray(approvals.status, req.query.status.split(",") as ("pending" | "approved")[]));
    const rows = await db.select().from(approvals).where(and(...conds)).orderBy(desc(approvals.createdAt)).limit(req.query.limit);
    return { data: rows.map(serializeApproval) };
  });

  app.get("/approvals/:id", { preHandler: app.authorize("workspace:read"), schema: { tags, params: z.object({ id: z.string() }) } }, async (req) => {
    const a = auth(req);
    const row = assertFound((await db.select().from(approvals).where(and(eq(approvals.id, req.params.id), eq(approvals.workspaceId, a.workspaceId))))[0], "Approval");
    return { ...serializeApproval(row), payload: row.payload };
  });

  /**
   * Decide an approval. Approvers may edit the action's input before approving (`payload`); the
   * edited input is what executes. The waiting run resumes in the background.
   */
  app.post(
    "/approvals/:id/decision",
    { preHandler: app.authorize("approvals:decide"), schema: { tags, params: z.object({ id: z.string() }), body: z.object({ decision: z.enum(["approved", "rejected"]), payload: z.record(z.string(), z.unknown()).optional(), note: z.string().max(1000).optional() }) } },
    async (req) => {
      const a = auth(req);
      const row = assertFound((await db.select().from(approvals).where(and(eq(approvals.id, req.params.id), eq(approvals.workspaceId, a.workspaceId))))[0], "Approval");
      if (row.approverRole && !roleAtLeast(a.role, row.approverRole)) throw forbidden(`This approval needs a ${row.approverRole} or above`);
      if (row.status !== "pending") throw conflict(`Already ${row.status}${row.decidedBy ? ` by ${row.decidedBy}` : ""}`);

      const patch: Partial<typeof approvals.$inferInsert> = { status: req.body.decision, decidedBy: a.userName, decidedAt: new Date() };
      if (req.body.decision === "approved" && req.body.payload) {
        const tool = [...toolByName.values()].find((t) => t.action === row.action);
        patch.payload = { ...row.payload, ...req.body.payload };
        const re = tool?.approval?.(patch.payload as never, { workspaceId: a.workspaceId, runId: row.runId ?? "", threadId: row.threadId, actor: row.requestedBy, onBehalfOf: { userId: null, name: row.onBehalfOf }, workspaceDomains: [], credentials: null });
        if (re) patch.preview = re.preview;
      }
      // Conditional update guards against two approvers racing.
      const [updated] = await db.update(approvals).set(patch).where(and(eq(approvals.id, row.id), eq(approvals.status, "pending"))).returning();
      if (!updated) throw conflict("This approval was just decided by someone else");

      await publish({ workspaceId: a.workspaceId, threadId: updated.threadId, runId: updated.runId, type: "approval.updated", data: serializeApproval(updated) });
      await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: `approval.${req.body.decision}`, target: `${row.action} · ${row.title}`, ip: req.ip, payload: { approvalId: row.id, edited: !!req.body.payload, note: req.body.note } });
      await emitWebhook(a.workspaceId, "approval.decided", serializeApproval(updated));
      if (updated.runId) await enqueue("run.advance", { runId: updated.runId }, { maxAttempts: 3 });
      return serializeApproval(updated);
    },
  );
};
