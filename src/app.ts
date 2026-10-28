import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { config } from "./config.js";
import { initTenantIsolation, sqlClient, withTenant } from "./db/client.js";
import { AppError } from "./lib/errors.js";
import authPlugin from "./plugins/auth.js";
import { registerRoutes } from "./modules/index.js";

export async function buildApp(opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  // Decided once per process, before any request: does the database have the tenant role?
  const rlsReady = initTenantIsolation();
  const app = Fastify({
    logger:
      opts.logger ??
      (config.LOG_LEVEL === "silent"
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.credentials", "*.token"],
            ...(config.NODE_ENV === "development" ? { transport: { target: "pino-pretty", options: { singleLine: true } } } : {}),
          }),
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(",").map((s) => s.trim()),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Workspace-Id", "X-Request-Id", "Last-Event-ID", "Idempotency-Key"],
    exposedHeaders: ["X-Request-Id"],
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.headers.authorization?.slice(-24) ?? req.ip,
    allowList: (req) => req.url.startsWith("/healthz") || req.url.startsWith("/readyz"),
  });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

  await app.register(swagger, {
    openapi: {
      info: { title: "Anvita AI API", version: "1.0.0", description: "REST API for the Anvita AI Workers platform. Authenticate with a user access token or an `anv_live_…` API key as a Bearer token." },
      servers: [{ url: config.PUBLIC_URL }],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: { code: "validation_error", message: "Request is invalid", details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) } });
    }
    const pgCode = (err as { code?: string; cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
    if (pgCode === "23505") return reply.status(409).send({ error: { code: "conflict", message: "A resource with this id already exists" } });
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: e.statusCode === 429 ? "rate_limited" : (e.code ?? "bad_request"), message: e.message } });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong", requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: "not_found", message: `Route ${req.method} ${req.url} not found` } }));

  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true }));
  app.get("/readyz", { schema: { hide: true } }, async (_req, reply) => {
    try {
      await sqlClient`select 1`;
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  await app.register(authPlugin);
  // Workspace-scoped handlers run in a tenant transaction (row-level security). Long-lived routes
  // (SSE) opt out with `config: { tenant: false }` and filter by workspace themselves.
  await rlsReady.then((on) => (on ? app.log.info("row-level security on") : config.RLS_ENABLED && app.log.warn("row-level security unavailable: run migrations as a role that can CREATE ROLE")));
  app.addHook("onRoute", (route) => {
    if ((route.config as { tenant?: boolean } | undefined)?.tenant === false) return;
    const handler = route.handler;
    route.handler = async function (this: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
      if (!req.tenantScoped || !req.auth?.workspaceId) return handler.call(this, req, reply);
      // reply.send()/redirect() inside the transaction are held until it commits, so a fast
      // follow-up request always sees what this one wrote (and rollbacks never leak a 2xx).
      let deferred: (() => unknown) | null = null;
      const proxy: FastifyReply = new Proxy(reply, {
        get(target, prop) {
          if (prop === "then") return undefined;
          if (prop === "send") return (payload?: unknown) => ((deferred = () => target.send(payload)), proxy);
          if (prop === "redirect") return (...args: unknown[]) => ((deferred = () => (target.redirect as (...a: unknown[]) => unknown)(...args)), proxy);
          const v = Reflect.get(target, prop, target);
          return typeof v === "function"
            ? (...args: unknown[]) => {
                const r = (v as (...a: unknown[]) => unknown).apply(target, args);
                return r === target ? proxy : r;
              }
            : v;
        },
      });
      const result = await withTenant(req.auth.workspaceId, async () => {
        const r = await handler.call(this, req, proxy);
        return r === proxy ? undefined : r;
      });
      if (deferred) {
        (deferred as () => unknown)();
        return reply;
      }
      return result;
    } as typeof handler;
  });
  await app.register(registerRoutes, { prefix: "/v1" });
  return app;
}
