# Deploying Anvita

This guide covers running the backend in staging and production: the moving parts, the
environment variables per concern, the release flow, backups, and observability.

## Moving parts

| Process | Command | What it does |
|---|---|---|
| **API** (`ROLE=api`) | `npm run start:api` | REST API, SSE events, public webhooks (`/v1/hooks/*`), widget script (`/widget.js`), `/metrics` |
| **Worker** (`ROLE=worker`) | `npm run start:worker` | Job queue: agent and workflow runs, approvals alerts, channel delivery, webhooks out, billing cycle, retention, embeddings |
| **Migrations** | `node dist/db/migrate.js` | Applies `migrations/*.sql` (also on API boot unless `MIGRATE_ON_START=false`) |
| **Postgres 16** | — | The only stateful dependency. Install `pgvector` for semantic knowledge search (optional). |
| **Sandbox** | — | Code steps run in Docker containers (`SANDBOX_PROVIDER=docker`, the production default). Give workers a Docker daemon (sidecar or `DOCKER_HOST`). |

`ROLE=all` (the default) runs both in one process — fine for a small install or local dev.
Every start script preloads `dist/telemetry.js`, which turns on OpenTelemetry and Sentry when
configured (see below).

The job queue lives in Postgres, so workers scale horizontally with no extra broker. Long
workflows yield back to the queue every `WORKFLOW_CHUNK_MS` and Wait steps are scheduled jobs,
so deploys and restarts never lose a run; workers drain in-flight jobs for up to 25 s on SIGTERM.

## Environments

Keep **staging** and **production** fully separate: their own database, secrets, payment keys
(test keys on staging), OAuth apps (redirect URIs point at each environment's `PUBLIC_URL`), and
Slack/WhatsApp apps. `deploy/staging.env.example` lists what staging needs.

To refresh staging with production data, restore a production backup into the staging database
(`scripts/restore.sh`), then rotate anything that would act on real customers: disable live
connections, or keep staging on a separate Slack/WhatsApp app so messages can't reach customers.

## Environment variables

Required in production (the API refuses to start without them):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | ≥ 32 random characters |
| `ENCRYPTION_KEY` | base64 of 32 random bytes — encrypts connector credentials, MFA secrets, BYO model keys. **Back it up separately; without it encrypted data is unrecoverable.** |
| `PUBLIC_URL`, `WEB_URL`, `CORS_ORIGINS` | API and web app origins |

By area (all optional; features stay off until set). See `.env.example` for the full list.

| Area | Variables |
|---|---|
| Models | `ANTHROPIC_API_KEY`, `MODEL_ACT` / `MODEL_PLAN` / `MODEL_FAST`. Workspaces can also bring their own key in Settings → Models. |
| Email | `RESEND_API_KEY`, `EMAIL_FROM` |
| Payments & GST | `RAZORPAY_*`, `STRIPE_*`, `TRIAL_DAYS`, `SELLER_NAME`, `SELLER_GSTIN`, `SELLER_ADDRESS`, `SELLER_STATE_CODE`, `INVOICE_SAC` |
| Sign-in | `GOOGLE_CLIENT_*`, `MICROSOFT_CLIENT_*` (SAML/SCIM are per workspace in the app) |
| Channels | `SLACK_SIGNING_SECRET`; WhatsApp, Teams, email and voice are configured per workspace |
| Browser push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| Workflows | `WORKFLOW_CHUNK_MS`, `WORKFLOW_MAX_STEPS`, `WORKFLOW_MAX_ACTIVE_MINUTES`, `WORKFLOW_MAX_DAYS` |
| Observability | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `METRICS_TOKEN` |

### Provider webhooks to register

| Provider | URL | Events |
|---|---|---|
| Razorpay | `{PUBLIC_URL}/v1/hooks/razorpay` | `order.paid`, `payment.captured`, `subscription.charged`, `subscription.halted`, `subscription.cancelled`, `subscription.completed` |
| Stripe | `{PUBLIC_URL}/v1/hooks/stripe` | `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted` |
| Slack | Events: `{PUBLIC_URL}/v1/hooks/slack/events` · Interactivity: `{PUBLIC_URL}/v1/hooks/slack/interactive` | `app_mention`, `message.im`; bot scopes `chat:write`, `users:read`, `users:read.email`, `im:write` |
| WhatsApp (Meta) | `{PUBLIC_URL}/v1/hooks/whatsapp` | `messages` |
| Email, voice, Teams | shown per channel in Settings → Channels | — |

## Release flow

`.github/workflows/ci.yml` runs on every PR: typecheck, schema/migration drift check, the full
test suite against Postgres with pgvector, a production build, a boot check of the built server,
and Docker builds.

`.github/workflows/release.yml`:

1. **Push to `main`** → builds and pushes `ghcr.io/<repo>:<branch>-<sha>` (+ `latest`) and the
   backup image, then deploys to the **staging** GitHub environment.
2. **Tag `v*`** → same images (+ `stable`), deployed to the **production** environment. Add
   required reviewers to that environment so production deploys wait for approval.

Each deploy runs the migration Job first and waits for it, then rolls the API (zero
unavailable pods) and workers. Deploy jobs are skipped — with a notice — until the environment
has a `KUBECONFIG` secret (base64 kubeconfig).

Kubernetes manifests are in `deploy/k8s` (base + `overlays/staging`, `overlays/production`):

```bash
kubectl create namespace anvita-staging
kubectl -n anvita-staging create secret generic anvita-env --from-env-file=staging.env
kubectl -n anvita-staging create secret generic anvita-backup-env \
  --from-literal=DATABASE_URL=postgres://… --from-literal=BACKUP_URI=s3://bucket/anvita-staging \
  --from-literal=AWS_ACCESS_KEY_ID=… --from-literal=AWS_SECRET_ACCESS_KEY=… --from-literal=AWS_DEFAULT_REGION=ap-south-1
kubectl apply -k deploy/k8s/overlays/staging
```

Not on Kubernetes? `docker-compose.yml` runs the same API/worker split; any platform that runs
two containers from one image (ECS, Cloud Run + a worker service, Render, Fly) works the same
way. Run the migration command before starting new API containers.

### Rolling back

Re-deploy the previous image tag (re-run the release workflow for the previous tag, or
`kubectl set image`). Migrations are additive, so the previous version runs against the newer
schema; never roll a migration back by hand on production.

## Backups

- **Point-in-time recovery** should come from managed Postgres (RDS, Cloud SQL, Azure Database):
  enable PITR with at least 7 days of retention.
- **Logical backups** (portable, restorable anywhere): `scripts/backup.sh` (`pg_dump` custom
  format, verified with `pg_restore --list`, optional GPG encryption, upload to `s3://` or `gs://`,
  local pruning). The `anvita-backup` CronJob runs it nightly.
- **Restore**: stop API and workers, then
  `DATABASE_URL=… scripts/restore.sh anvita-20261113T020000Z.dump`. It refuses database names
  containing `prod` unless `CONFIRM_PROD=yes`. Start the API afterwards to apply newer migrations.
- Keep `ENCRYPTION_KEY` and `JWT_SECRET` in your secret manager with their own backups.
- Test a restore into staging every month.

## Observability

- **Logs**: JSON (pino) to stdout with request ids; ship them with your platform's log agent.
- **Traces**: set `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP; e.g. an OpenTelemetry Collector,
  Grafana Tempo, Honeycomb, Datadog). Incoming requests, Postgres queries, outbound HTTP
  (connectors, model calls) and every background job (`job <type>` spans with `anvita.run_id`) are
  traced. Standard `OTEL_*` variables (sampling, headers, resource attributes) apply.
- **Errors**: set `SENTRY_DSN`. Unhandled 5xx responses (with route, request id, workspace) and
  jobs that fail permanently are reported. Releases are tagged from the image build.
- **Metrics**: set `METRICS_TOKEN` and scrape `GET /metrics` with
  `Authorization: Bearer <token>`. Suggested alerts:

| Metric | Alert when |
|---|---|
| `anvita_http_request_duration_seconds` | p95 > 2 s for 10 min, or 5xx rate > 2 % |
| `anvita_jobs_queued{state="due"}` | > 100 for 10 min (workers can't keep up — add replicas) |
| `anvita_jobs_processed_total{outcome="failed"}` | any increase (also in Sentry) |
| `anvita_runs_active{status="waiting_approval"}` | business signal: approvals piling up |
| `/readyz` | failing for 2 min (database unreachable) |

## Security checklist

- Terminate TLS in front of the API; set `CORS_ORIGINS` to the web app origin only.
- Use a Postgres role that owns the schema for migrations; the app also uses the
  `anvita_tenant` role for row-level security (created by migration 0009).
- Code steps in production: `SANDBOX_PROVIDER=docker` (network-isolated containers). Never use
  `process` for multi-tenant installs.
- Rotate `JWT_SECRET` to sign everyone out; rotating `ENCRYPTION_KEY` requires re-encrypting
  stored secrets (not automated).
- Restrict `/metrics` with `METRICS_TOKEN` and keep it off the public load balancer if possible.
