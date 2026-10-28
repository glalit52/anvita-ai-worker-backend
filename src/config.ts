import "dotenv/config";
import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** api = HTTP only, worker = job runner only, all = both in one process (dev / small deployments). */
  ROLE: z.enum(["api", "worker", "all"]).default("all"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  WEB_URL: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  DATABASE_URL: z.string().default("postgres://anvita:anvita@localhost:5432/anvita"),
  DATABASE_POOL_MAX: z.coerce.number().int().default(10),

  /** HMAC secret for access tokens. Must be >= 32 chars in production. */
  JWT_SECRET: z.string().min(16).default("dev-only-insecure-jwt-secret-change-me"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  /** 32-byte key (base64 or hex) used to encrypt connection credentials at rest. */
  ENCRYPTION_KEY: z.string().default("ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE="),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** Model tiers (see docs/technical-architecture.md §4.4). Configurable per deployment. */
  MODEL_ACT: z.string().default("claude-sonnet-5-5"),
  MODEL_PLAN: z.string().default("claude-opus-5-5"),
  MODEL_FAST: z.string().default("claude-haiku-5-5"),
  /** "anthropic" calls Claude; "scripted" is a deterministic offline model for dev/tests/demos. Default: anthropic when a key is set. */
  MODEL_PROVIDER: z.enum(["anthropic", "scripted"]).optional(),
  AGENT_MAX_STEPS: z.coerce.number().int().default(24),
  AGENT_MAX_TOKENS: z.coerce.number().int().default(16000),

  JOBS_CONCURRENCY: z.coerce.number().int().default(4),
  JOBS_POLL_MS: z.coerce.number().int().default(1000),
  SCHEDULER_ENABLED: bool.default(true),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(600),
  /** Per-client limit on login/signup/refresh/invite endpoints (brute-force protection). */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(10),
  SIGNUP_ENABLED: bool.default(true),
  /** Credits granted to a new workspace (Business plan default from the product spec). */
  DEFAULT_PLAN_CREDITS: z.coerce.number().int().default(200000),

  /** Payments: Razorpay (India, UPI) and/or Stripe Checkout. Unset → admins record top-ups manually. */
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Price of 1,000 credits in the smallest currency unit's major unit (₹100 by default). */
  CREDITS_PRICE_PER_1000: z.coerce.number().default(100),
  BILLING_CURRENCY: z.string().default("INR"),
  /** Signing secret of the Anvita Slack app (Events API). */
  SLACK_SIGNING_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Anvita <no-reply@anvita.ai>"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production") {
    if (cfg.JWT_SECRET.startsWith("dev-only") || cfg.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be set to a random value of at least 32 characters in production");
    if (cfg.ENCRYPTION_KEY === schema.shape.ENCRYPTION_KEY.parse(undefined)) throw new Error("ENCRYPTION_KEY must be set in production");
  }
  return cfg;
}

export const config = loadConfig();

export function modelProvider(): "anthropic" | "scripted" {
  return config.MODEL_PROVIDER ?? (config.ANTHROPIC_API_KEY ? "anthropic" : "scripted");
}
