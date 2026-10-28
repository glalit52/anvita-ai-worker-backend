import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";
import { enqueue } from "../jobs/queue.js";
import { connectionByExternalId, firstDelivery } from "../channels/common.js";
import { verifySlackSignature, type SlackEventEnvelope } from "../channels/slack.js";
import { verifyMetaSignature, verifyTokenMatches, type WaChange } from "../channels/whatsapp.js";

/**
 * Inbound channel webhooks (public, signature-verified). Events are acknowledged immediately and
 * processed in the job queue; duplicate deliveries are dropped by event id.
 *
 *   Slack:    POST /v1/hooks/slack/events   (Event Subscriptions request URL)
 *   WhatsApp: GET+POST /v1/hooks/whatsapp   (Meta webhook callback URL)
 */
export const channelRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });
  const raw = (req: unknown) => (req as { rawBody?: string }).rawBody ?? "";

  app.post("/hooks/slack/events", { schema: { hide: true }, config: { rateLimit: false } }, async (req, reply) => {
    if (!verifySlackSignature(raw(req), req.headers["x-slack-request-timestamp"] as string, req.headers["x-slack-signature"] as string, config.SLACK_SIGNING_SECRET)) return reply.status(401).send({ error: { code: "unauthorized", message: "Bad Slack signature" } });
    const body = req.body as { type: string; challenge?: string } & Partial<SlackEventEnvelope>;
    if (body.type === "url_verification") return { challenge: body.challenge };
    if (body.type === "event_callback" && body.event_id && (await firstDelivery(`slack:${body.event_id}`))) await enqueue("slack.event", body as unknown as Record<string, unknown>, { maxAttempts: 3 });
    return reply.status(200).send({ ok: true });
  });

  app.get("/hooks/whatsapp", { schema: { hide: true } }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] && (await verifyTokenMatches(q["hub.verify_token"]))) return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    return reply.status(403).send("Verification failed");
  });

  app.post("/hooks/whatsapp", { schema: { hide: true }, config: { rateLimit: false } }, async (req, reply) => {
    const body = req.body as { entry?: { changes?: { field: string; value: WaChange["value"] }[] }[] };
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages" || !change.value?.metadata?.phone_number_id) continue;
        const conn = await connectionByExternalId("whatsapp", change.value.metadata.phone_number_id);
        if (!conn) continue;
        if (!verifyMetaSignature(raw(req), req.headers["x-hub-signature-256"] as string, conn.credentials.fields?.app_secret)) return reply.status(401).send({ error: { code: "unauthorized", message: "Bad signature" } });
        const fresh = [];
        for (const m of change.value.messages ?? []) if (await firstDelivery(`wa:${m.id}`)) fresh.push(m);
        if (fresh.length) await enqueue("whatsapp.message", { value: { ...change.value, messages: fresh } }, { maxAttempts: 3 });
      }
    }
    return reply.status(200).send({ ok: true });
  });
};
