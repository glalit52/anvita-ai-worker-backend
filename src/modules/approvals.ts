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
import { config } from "../config.js";
import { decideApproval, deciderFor, readDecisionToken } from "../services/approval-alerts.js";

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
      const updated = await decideApproval(a.workspaceId, req.params.id, { userId: a.userId, name: a.userName, role: a.role }, req.body.decision, { payload: req.body.payload, note: req.body.note, ip: req.ip, via: a.userId ? "web" : "api" });
      return serializeApproval(updated);
    },
  );
};

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#111}button{font:inherit;padding:10px 20px;border-radius:8px;border:0;color:#fff;cursor:pointer}a{color:#5b4cf0}p{color:#444}</style></head><body>${body}</body></html>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * One-click approval links from email. GET only shows a confirmation (mail scanners prefetch
 * links), POST decides. The signed token names the approver, so no sign-in is needed.
 */
export const approvalLinkRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
  const q = { querystring: z.object({ t: z.string().max(2000) }) };
  app.get("/approvals/respond", { schema: { hide: true, ...q } }, async (req, reply) => {
    reply.type("text/html");
    const t = await readDecisionToken(req.query.t);
    if (!t) return reply.status(400).send(page("Link expired", "<h2>This link has expired</h2><p>Open Anvita to review the request.</p>"));
    const [row] = await db.select().from(approvals).where(eq(approvals.id, t.approvalId));
    if (!row) return reply.status(404).send(page("Not found", "<h2>Request not found</h2>"));
    if (row.status !== "pending") return page("Already decided", `<h2>${esc(row.title)}</h2><p>Already ${row.status}${row.decidedBy ? ` by ${esc(row.decidedBy)}` : ""}.</p>`);
    const verb = t.decision === "approved" ? "Approve" : "Reject";
    return page(`${verb}?`, `<h2>${esc(row.title)}</h2><p>${esc(row.reason)}</p><form method="post"><input type="hidden" name="t" value="${esc(req.query.t)}"><button style="background:${t.decision === "approved" ? "#16a34a" : "#dc2626"}">${verb}</button></form><p><a href="${config.WEB_URL}/approvals?id=${row.id}">Review or edit in Anvita instead</a></p>`);
  });

  app.post("/approvals/respond", { schema: { hide: true, body: z.object({ t: z.string().max(2000) }) } }, async (req, reply) => {
    reply.type("text/html");
    const t = await readDecisionToken(req.body.t);
    if (!t) return reply.status(400).send(page("Link expired", "<h2>This link has expired</h2>"));
    const who = await deciderFor(t.workspaceId, { userId: t.userId });
    if (!who) return reply.status(403).send(page("Not allowed", "<h2>You're no longer a member of this workspace</h2>"));
    try {
      const row = await decideApproval(t.workspaceId, t.approvalId, who, t.decision, { ip: req.ip, via: "email" });
      return page("Done", `<h2>${row.status === "approved" ? "✅ Approved" : "❌ Rejected"}</h2><p>${esc(row.title)}</p><p><a href="${config.WEB_URL}/approvals">Open approvals</a></p>`);
    } catch (e) {
      return reply.status(409).send(page("Couldn't decide", `<h2>${esc((e as Error).message)}</h2>`));
    }
  });
};
