import * as Sentry from "@sentry/node";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import client from "prom-client";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

/**
 * Error reporting, spans and Prometheus metrics. All no-ops when Sentry / OTel aren't
 * configured (see src/telemetry.ts); metrics are only exposed when METRICS_TOKEN is set.
 */

export function reportError(err: unknown, context: Record<string, unknown> = {}) {
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(context)) {
      if (typeof v === "string" || typeof v === "number") scope.setTag(k, String(v));
      else scope.setExtra(k, v);
    }
    Sentry.captureException(err);
  });
}

const tracer = trace.getTracer("anvita");

/** Run `fn` inside a span (a no-op span when tracing isn't configured). */
export function withSpan<T>(name: string, attributes: Record<string, string | number | boolean>, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "anvita_" });

export const httpDuration = new client.Histogram({
  name: "anvita_http_request_duration_seconds",
  help: "API request latency by route",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const jobsProcessed = new client.Counter({
  name: "anvita_jobs_processed_total",
  help: "Background jobs by type and outcome",
  labelNames: ["type", "outcome"] as const,
  registers: [registry],
});

export const jobDuration = new client.Histogram({
  name: "anvita_job_duration_seconds",
  help: "Background job duration by type",
  labelNames: ["type"] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 30, 60, 120, 300],
  registers: [registry],
});

new client.Gauge({
  name: "anvita_jobs_queued",
  help: "Jobs waiting to run (due now) and scheduled for later",
  labelNames: ["state"] as const,
  registers: [registry],
  async collect() {
    const [r] = (await db.execute(sql`select count(*) filter (where status = 'queued' and run_at <= now())::int as due, count(*) filter (where status = 'queued' and run_at > now())::int as scheduled, count(*) filter (where status = 'running')::int as running from jobs`)) as unknown as { due: number; scheduled: number; running: number }[];
    this.set({ state: "due" }, r?.due ?? 0);
    this.set({ state: "scheduled" }, r?.scheduled ?? 0);
    this.set({ state: "running" }, r?.running ?? 0);
  },
});

new client.Gauge({
  name: "anvita_runs_active",
  help: "Agent and workflow runs by non-terminal status",
  labelNames: ["status"] as const,
  registers: [registry],
  async collect() {
    const rows = (await db.execute(sql`select status, count(*)::int as n from runs where status in ('queued','running','waiting','waiting_approval','waiting_auth') group by status`)) as unknown as { status: string; n: number }[];
    this.reset();
    for (const r of rows) this.set({ status: r.status }, r.n);
  },
});
