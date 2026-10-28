import type { FastifyPluginAsync } from "fastify";
import { markPaid, verifyRazorpayWebhook, verifyStripeWebhook } from "../services/payments.js";

/** Payment provider webhooks (public, signature-verified, idempotent). */
export const billingHookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });
  const raw = (req: unknown) => (req as { rawBody?: string }).rawBody ?? "";

  app.post("/hooks/razorpay", { schema: { hide: true }, config: { rateLimit: false } }, async (req, reply) => {
    if (!verifyRazorpayWebhook(raw(req), req.headers["x-razorpay-signature"] as string | undefined)) return reply.status(401).send({ error: { code: "unauthorized", message: "Bad signature" } });
    const body = req.body as { event: string; payload?: { payment?: { entity?: { order_id?: string; id?: string } }; order?: { entity?: { id?: string } } } };
    if (body.event === "order.paid" || body.event === "payment.captured") {
      const orderId = body.payload?.order?.entity?.id ?? body.payload?.payment?.entity?.order_id;
      if (orderId) await markPaid("razorpay", orderId, { razorpayPaymentId: body.payload?.payment?.entity?.id });
    }
    return { ok: true };
  });

  app.post("/hooks/stripe", { schema: { hide: true }, config: { rateLimit: false } }, async (req, reply) => {
    if (!verifyStripeWebhook(raw(req), req.headers["stripe-signature"] as string | undefined)) return reply.status(401).send({ error: { code: "unauthorized", message: "Bad signature" } });
    const body = req.body as { type: string; data?: { object?: { id?: string; payment_status?: string } } };
    if ((body.type === "checkout.session.completed" || body.type === "checkout.session.async_payment_succeeded") && body.data?.object?.id && body.data.object.payment_status === "paid") await markPaid("stripe", body.data.object.id);
    return { received: true };
  });
};
