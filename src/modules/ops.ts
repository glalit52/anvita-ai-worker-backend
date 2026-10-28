import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { approvals, creditLedger, inboxConversations, messages, payments, runs, threads, workers, workspaces } from "../db/schema.js";
import { sendToChannel } from "../channels/deliver.js";
import { AppError, assertFound, badRequest, conflict } from "../lib/errors.js";
import { config } from "../config.js";
import { createCheckout, markPaid, providers, verifyRazorpayPayment } from "../services/payments.js";
import { newId } from "../lib/ids.js";
import { auth } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { getBalance, grant, usageByDay } from "../services/credits.js";
import { publish } from "../services/events.js";
import { serializeInbox, serializeMessage } from "../services/serializers.js";

export const opsRoutes: FastifyPluginAsyncZod = async (app) => {
  const idParam = z.object({ id: z.string() });

  // ─── Billing ───
  app.get("/billing", { preHandler: app.authorize("workspace:read"), schema: { tags: ["billing"] } }, async (req) => {
    const a = auth(req);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, a.workspaceId));
    return { plan: ws.plan, renewsOn: ws.renewsAt?.toISOString() ?? null, ...(await getBalance(a.workspaceId)), usageByDay: await usageByDay(a.workspaceId, 30) };
  });

  app.get("/billing/ledger", { preHandler: app.authorize("billing:manage"), schema: { tags: ["billing"], querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) } }, async (req) => {
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, auth(req).workspaceId)).orderBy(desc(creditLedger.id)).limit(req.query.limit);
    return { data: rows.map((r) => ({ id: r.id, delta: r.delta, reason: r.reason, refType: r.refType, refId: r.refId, createdAt: r.createdAt.toISOString() })) };
  });

  app.get("/billing/providers", { preHandler: app.authorize("workspace:read"), schema: { tags: ["billing"] } }, async () => ({ ...providers(), pricePer1000: config.CREDITS_PRICE_PER_1000, currency: config.BILLING_CURRENCY }));

  /** Start a credit purchase: a Razorpay order (complete it with Checkout, then /billing/razorpay/verify) or a Stripe Checkout URL. */
  app.post("/billing/checkout", { preHandler: app.authorize("billing:manage"), schema: { tags: ["billing"], body: z.object({ credits: z.number().int().min(1000).max(10_000_000), provider: z.enum(["razorpay", "stripe"]).optional() }) } }, async (req) => {
    const a = auth(req);
    return createCheckout({ workspaceId: a.workspaceId, userId: a.userId, credits: req.body.credits, provider: req.body.provider });
  });

  /** Razorpay Checkout success handler: verify the signature and grant credits (the webhook does the same, idempotently). */
  app.post("/billing/razorpay/verify", { preHandler: app.authorize("billing:manage"), schema: { tags: ["billing"], body: z.object({ orderId: z.string(), paymentId: z.string(), signature: z.string() }) } }, async (req) => {
    const a = auth(req);
    if (!verifyRazorpayPayment(req.body.orderId, req.body.paymentId, req.body.signature)) throw badRequest("Payment signature didn't verify");
    const [p] = await db.select().from(payments).where(and(eq(payments.provider, "razorpay"), eq(payments.providerRef, req.body.orderId), eq(payments.workspaceId, a.workspaceId)));
    assertFound(p, "Payment");
    await markPaid("razorpay", req.body.orderId, { razorpayPaymentId: req.body.paymentId });
    return getBalance(a.workspaceId);
  });

  /** Manual top-up for self-hosted / development setups without a payment provider. */
  app.post("/billing/topup", { preHandler: app.authorize("billing:manage"), schema: { tags: ["billing"], body: z.object({ credits: z.number().int().min(1000).max(10_000_000), reference: z.string().max(200).optional() }) } }, async (req) => {
    const a = auth(req);
    const avail = providers();
    if (avail.razorpay || avail.stripe) throw badRequest("Buy credits through checkout");
    await grant(a.workspaceId, req.body.credits, "topup", { by: a.userId, provider: "manual", reference: req.body.reference ?? null });
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "billing.topup", target: `${req.body.credits.toLocaleString("en-IN")} credits`, ip: req.ip });
    const balance = await getBalance(a.workspaceId);
    await publish({ workspaceId: a.workspaceId, type: "billing.updated", data: balance });
    return balance;
  });

  // ─── Analytics ───
  app.get("/analytics/overview", { preHandler: app.authorize("workspace:read"), schema: { tags: ["analytics"], querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) } }, async (req) => {
    const a = auth(req);
    const since = new Date(Date.now() - req.query.days * 86400_000);
    const scope = and(eq(runs.workspaceId, a.workspaceId), gte(runs.createdAt, since));
    const [totals] = await db
      .select({
        runs: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
        agentRuns: sql<number>`count(*) filter (where ${runs.kind} = 'agent')::int`,
        workerRuns: sql<number>`count(*) filter (where ${runs.kind} = 'worker')::int`,
        credits: sql<number>`coalesce(sum(${runs.creditsUsed}),0)::int`,
        avgDurationMs: sql<number>`coalesce(avg(extract(epoch from (${runs.endedAt} - ${runs.startedAt})) * 1000) filter (where ${runs.endedAt} is not null), 0)::int`,
      })
      .from(runs)
      .where(scope);
    const byDay = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${runs.createdAt}), 'YYYY-MM-DD')`,
        runs: sql<number>`count(*)::int`,
        agent: sql<number>`coalesce(sum(${runs.creditsUsed}) filter (where ${runs.kind} = 'agent'),0)::int`,
        workers: sql<number>`coalesce(sum(${runs.creditsUsed}) filter (where ${runs.kind} = 'worker'),0)::int`,
        automated: sql<number>`count(*) filter (where ${runs.kind} = 'worker' and ${runs.status} = 'succeeded')::int`,
      })
      .from(runs)
      .where(scope)
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const byWorker = await db
      .select({ workerId: runs.workerId, name: workers.name, emoji: workers.emoji, runs: sql<number>`count(*)::int`, succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')::int`, credits: sql<number>`coalesce(sum(${runs.creditsUsed}),0)::int` })
      .from(runs)
      .innerJoin(workers, eq(workers.id, runs.workerId))
      .where(and(scope, eq(runs.kind, "worker")))
      .groupBy(runs.workerId, workers.name, workers.emoji)
      .orderBy(sql`4 desc`);
    const [appr] = await db
      .select({
        pending: sql<number>`count(*) filter (where ${approvals.status} = 'pending')::int`,
        decided: sql<number>`count(*) filter (where ${approvals.status} in ('approved','rejected'))::int`,
        approved: sql<number>`count(*) filter (where ${approvals.status} = 'approved')::int`,
        avgDecisionMinutes: sql<number>`coalesce(avg(extract(epoch from (${approvals.decidedAt} - ${approvals.createdAt})) / 60) filter (where ${approvals.decidedAt} is not null), 0)::float`,
      })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, a.workspaceId), gte(approvals.createdAt, since)));
    const byMember = await db
      .select({ name: sql<string>`coalesce(${runs.createdByName}, 'Unknown')`, runs: sql<number>`count(*)::int`, credits: sql<number>`coalesce(sum(${runs.creditsUsed}),0)::int`, succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')::int` })
      .from(runs)
      .where(and(scope, eq(runs.kind, "agent")))
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`)
      .limit(25);
    const byChannel = await db
      .select({ channel: runs.trigger, runs: sql<number>`count(*)::int`, credits: sql<number>`coalesce(sum(${runs.creditsUsed}),0)::int` })
      .from(runs)
      .where(scope)
      .groupBy(runs.trigger)
      .orderBy(sql`2 desc`);
    const finished = totals.succeeded + totals.failed;
    return {
      days: req.query.days,
      ...totals,
      successRate: finished ? totals.succeeded / finished : 0,
      automationRate: totals.runs ? totals.workerRuns / totals.runs : 0,
      // Estimate: 12 minutes of manual work saved per successful run.
      hoursSaved: Math.round((totals.succeeded * 12) / 60),
      byDay,
      byWorker: byWorker.map((w) => ({ ...w, successRate: w.runs ? w.succeeded / w.runs : 0 })),
      byMember,
      byChannel,
      approvals: appr,
      balance: await getBalance(a.workspaceId),
    };
  });

  // ─── Human inbox (handoffs from customer-facing Workers) ───
  const itags = ["inbox"];
  app.get("/inbox", { preHandler: app.authorize("workspace:read"), schema: { tags: itags, querystring: z.object({ status: z.enum(["open", "taken", "resolved"]).optional() }) } }, async (req) => {
    const a = auth(req);
    const conds = [eq(inboxConversations.workspaceId, a.workspaceId)];
    if (req.query.status) conds.push(eq(inboxConversations.status, req.query.status));
    const rows = await db.select().from(inboxConversations).where(and(...conds)).orderBy(desc(inboxConversations.waitingSince)).limit(200);
    return { data: rows.map(serializeInbox) };
  });

  /** Workers / the channel gateway hand a conversation to humans. */
  app.post(
    "/inbox",
    {
      preHandler: app.authorize("workers:run"),
      schema: {
        tags: itags,
        body: z.object({
          workerId: z.string().optional(),
          workerName: z.string().max(100),
          customer: z.string().max(200),
          phone: z.string().max(40).default(""),
          channel: z.enum(["whatsapp", "voice", "widget"]),
          reason: z.string().max(300),
          sentiment: z.enum(["negative", "neutral", "positive"]).default("neutral"),
          language: z.string().max(40).default("English"),
          summary: z.string().max(4000).default(""),
          transcript: z.array(z.object({ from: z.enum(["customer", "worker", "agent"]), text: z.string().max(4000), time: z.string().max(40) })).max(500).default([]),
        }),
      },
    },
    async (req, reply) => {
      const a = auth(req);
      const [c] = await db.insert(inboxConversations).values({ id: newId("inb"), workspaceId: a.workspaceId, ...req.body }).returning();
      await publish({ workspaceId: a.workspaceId, type: "inbox.updated", data: serializeInbox(c) });
      return reply.status(201).send(serializeInbox(c));
    },
  );

  app.get("/inbox/:id", { preHandler: app.authorize("workspace:read"), schema: { tags: itags, params: idParam } }, async (req) => {
    const a = auth(req);
    return serializeInbox(assertFound((await db.select().from(inboxConversations).where(and(eq(inboxConversations.id, req.params.id), eq(inboxConversations.workspaceId, a.workspaceId))))[0], "Conversation"));
  });

  const act = async (workspaceId: string, id: string, patch: Partial<typeof inboxConversations.$inferInsert>) => {
    const [c] = await db.update(inboxConversations).set({ ...patch, updatedAt: new Date() }).where(and(eq(inboxConversations.id, id), eq(inboxConversations.workspaceId, workspaceId))).returning();
    assertFound(c, "Conversation");
    await publish({ workspaceId, type: "inbox.updated", data: serializeInbox(c) });
    return serializeInbox(c);
  };

  app.post("/inbox/:id/take", { preHandler: app.authorize("inbox:write"), schema: { tags: itags, params: idParam } }, async (req) => {
    const a = auth(req);
    const [cur] = await db.select().from(inboxConversations).where(and(eq(inboxConversations.id, req.params.id), eq(inboxConversations.workspaceId, a.workspaceId)));
    if (assertFound(cur, "Conversation").status === "taken" && cur.assigneeId !== a.userId) throw conflict(`Already taken by ${cur.assigneeName}`);
    return act(a.workspaceId, req.params.id, { status: "taken", assigneeId: a.userId, assigneeName: a.userName });
  });

  /** Hand back to the Worker / reopen. */
  app.post("/inbox/:id/release", { preHandler: app.authorize("inbox:write"), schema: { tags: itags, params: idParam } }, async (req) => act(auth(req).workspaceId, req.params.id, { status: "open", assigneeId: null, assigneeName: null }));

  app.post("/inbox/:id/resolve", { preHandler: app.authorize("inbox:write"), schema: { tags: itags, params: idParam } }, async (req) => {
    const a = auth(req);
    const out = await act(a.workspaceId, req.params.id, { status: "resolved" });
    await audit({ workspaceId: a.workspaceId, actor: a.userName, actorId: a.userId, action: "inbox.resolved", target: `${out.customer} · ${out.reason}`, ip: req.ip });
    return out;
  });

  /** Human reply: appended to the transcript; delivery goes through the conversation's channel connector. */
  app.post("/inbox/:id/reply", { preHandler: app.authorize("inbox:write"), schema: { tags: itags, params: idParam, body: z.object({ text: z.string().trim().min(1).max(4000) }) } }, async (req) => {
    const a = auth(req);
    const [cur] = await db.select().from(inboxConversations).where(and(eq(inboxConversations.id, req.params.id), eq(inboxConversations.workspaceId, a.workspaceId)));
    const c = assertFound(cur, "Conversation");
    const time = new Date().toISOString();
    // Deliver to the customer first (WhatsApp etc.); only record the reply once it's sent.
    if (c.threadId) {
      const [t] = await db.select().from(threads).where(eq(threads.id, c.threadId));
      if (t?.externalRef) {
        try {
          await sendToChannel(a.workspaceId, t.externalRef, req.body.text);
        } catch (e) {
          throw new AppError(502, "delivery_failed", `Couldn't deliver the reply: ${(e as Error).message}`);
        }
        const [msg] = await db.insert(messages).values({ id: newId("msg"), workspaceId: a.workspaceId, threadId: t.id, role: "assistant", author: a.userName, authorId: a.userId, blocks: [{ type: "text", text: req.body.text }] }).returning();
        await publish({ workspaceId: a.workspaceId, threadId: t.id, type: "message.created", data: serializeMessage(msg) });
      }
    }
    return act(a.workspaceId, c.id, { transcript: [...c.transcript, { from: "agent", text: req.body.text, time }], status: c.status === "open" ? "taken" : c.status, assigneeId: c.assigneeId ?? a.userId, assigneeName: c.assigneeName ?? a.userName });
  });

  app.patch("/inbox/:id", { preHandler: app.authorize("inbox:write"), schema: { tags: itags, params: idParam, body: z.object({ notes: z.string().max(10_000).optional() }) } }, async (req) => act(auth(req).workspaceId, req.params.id, req.body));
};
