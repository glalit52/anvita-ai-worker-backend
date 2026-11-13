/**
 * Observability bootstrap, loaded before the app with `node --import ./dist/telemetry.js`
 * (see the start scripts) so instrumentation can hook modules as they load. Everything is
 * opt-in through environment variables:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT   traces (HTTP, PostgreSQL, outbound fetch, Fastify) over OTLP/HTTP
 *   OTEL_SERVICE_NAME             defaults to anvita-api / anvita-worker by ROLE
 *   SENTRY_DSN                    error reporting (unhandled 5xx and permanently failed jobs)
 *   SENTRY_ENVIRONMENT, SENTRY_RELEASE
 *
 * Sentry doesn't register an OpenTelemetry tracer provider by default, so both can run together.
 */
import "dotenv/config";
import * as Sentry from "@sentry/node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

const role = process.env.ROLE ?? "all";
const environment = process.env.SENTRY_ENVIRONMENT ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment,
    release: process.env.SENTRY_RELEASE,
    serverName: process.env.HOSTNAME,
    initialScope: { tags: { role } },
    // Errors only; traces go to the OTLP pipeline when one is configured.
    tracesSampleRate: 0,
  });
}

let sdk: NodeSDK | null = null;
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  process.env.OTEL_SERVICE_NAME ??= role === "worker" ? "anvita-worker" : "anvita-api";
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noisy and low value for this service.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
        "@opentelemetry/instrumentation-http": { ignoreIncomingRequestHook: (req) => req.url === "/healthz" || req.url === "/readyz" || req.url === "/metrics" },
      }),
    ],
  });
  sdk.start();
}

const flush = async () => {
  await Promise.allSettled([sdk?.shutdown(), Sentry.flush(2000)]);
};
process.once("beforeExit", () => void flush());
export { flush as flushTelemetry };
