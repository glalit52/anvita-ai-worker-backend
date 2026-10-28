# Anvita AI Workers — Backend

The API and agent runtime behind the [Anvita web app](https://github.com/glalit52/anvita-ai-workers).
It turns the frontend's mock store into a real multi-tenant service: auth and workspaces, chat with
a Claude-powered agent that pulls data, builds files and takes governed actions, AI Workers
(Studio graphs, versions, schedules, webhooks, evals), approvals, knowledge, memory, policies,
audit, billing credits, and realtime streaming.

- **Stack:** Node 22, TypeScript, Fastify 5, PostgreSQL 16 (Drizzle ORM + SQL migrations), Zod, Anthropic SDK.
- **Design:** follows `docs/technical-architecture.md` in the frontend repo. Response shapes match the web app's `src/lib/types.ts` (mirrored in [`src/contracts/web.ts`](src/contracts/web.ts)).

## Quick start

```bash
cp .env.example .env               # set ANTHROPIC_API_KEY to use Claude; leave empty for the offline model
docker compose up -d postgres      # or point DATABASE_URL at any Postgres 16
npm ci
npm run db:migrate
npm run db:seed                    # optional: demo workspace "Kesar Foods"
npm run dev                        # http://localhost:4000 · API docs at /docs
```

Demo login after seeding: `priya@kesarfoods.in` / `anvita-demo-2026` (teammates such as
`rahul@kesarfoods.in` (builder) and `aman@kesarfoods.in` (member) use the same password).

Without `ANTHROPIC_API_KEY` the runtime uses a deterministic **scripted model** that speaks the same
tool-use protocol as Claude, so every flow (plans, connect cards, approvals, artifacts, Workers)
works offline, in CI, and in demos.

## Architecture

```
            ┌──────────── API (ROLE=api) ────────────┐        ┌──── Worker (ROLE=worker) ────┐
 Web app ──▶│ Fastify · auth · RBAC · Zod validation  │        │ Job runner (SKIP LOCKED)      │
  (SSE) ◀───│ REST /v1 · SSE /v1/events/stream        │        │  run.advance → Agent runtime  │
            └───────┬──────────────────────▲──────────┘        │  webhook.deliver · evals.run  │
                    │ enqueue               │ LISTEN/NOTIFY     │ Scheduler (cron, expiry, GC)  │
                    ▼                       │                   └──────────────┬────────────────┘
            ┌──────────────────────── PostgreSQL ─────────────────────────────▼───┐
            │ tenants · threads/messages · runs (durable state) · approvals · jobs │
            │ events (SSE log) · audit (hash chain) · credit ledger · kb (FTS) …   │
            └──────────────────────────────────────────────────────────────────────┘
```

`ROLE=all` (default) runs both in one process; in production run them as separate deployments.

### Agent runtime ([`src/runtime/agent.ts`](src/runtime/agent.ts))

A Claude tool-use loop whose **entire state lives in `runs.state`** (transcript + pending tool
calls), so a run can pause for days and resume on any instance:

1. A chat message creates the user/assistant messages and a run, then enqueues `run.advance`.
2. The runtime streams model text into the assistant message (throttled DB writes + SSE events).
3. Each tool call goes through, in order:
   **connection check** → if the app isn't connected the run parks as `waiting_auth` and the UI shows a connect card;
   **policy engine** → `allow`, `deny` (blocked, model told not to retry) or `approve`, which creates an approval, notifies approvers and parks as `waiting_approval`;
   **execution** → result returned to the model wrapped as untrusted data; credits metered; step recorded; side effects audited.
4. Connecting the app or deciding the approval re-enqueues the run, which resumes exactly where it stopped (approvers can edit the action's input before approving).
5. On completion: sources, actual credits on the plan, and a "Save as AI Worker" offer; `run.completed` webhook.

Runs are serialized per run with an advisory lock; cancellation, step limits, refusal handling and
`pause_turn` are handled. The model router uses Claude with prompt caching on tools/system,
server-side web search when requested, and server-side refusal fallback (`fallbacks: "default"`).
Model tiers are configurable (`MODEL_ACT`, `MODEL_PLAN`, `MODEL_FAST`).

### Tools ([`src/runtime/tools/index.ts`](src/runtime/tools/index.ts))

Built-ins: `share_plan`, `kb_search` (Postgres full-text search with citations), `memory_search`,
`memory_save`, `create_artifact` (reports, CSVs, chart specs, HTML dashboards). App actions:
HubSpot, Shopify, Meta Ads, Google Ads, GA4, Zendesk, Tally, Google Calendar, Gmail, Slack,
WhatsApp, Razorpay — each declares its side effect, policy facts (amount, recipients, external
recipients…) and approval preview. Connectors run through a driver layer: **Slack is live** with a
bot token; other apps use a clearly-labelled demo driver until their live drivers/OAuth are added.

### Policies ([`src/runtime/policy.ts`](src/runtime/policy.ts))

Action globs (`gmail.send`, `*.delete`, `hubspot.*.update`) plus a small, validated condition
language: `amount > 5000`, `external_recipients > 0 and actor == worker`, `app in [razorpay, stripe]`,
`not (...)`. Most restrictive matching rule wins (deny > approve > allow); with no match, external
and destructive actions need approval. `POST /v1/policies/evaluate` dry-runs a decision.

## API overview

All routes are under `/v1`, take `Authorization: Bearer <access token | anv_live_… API key>` and
optionally `X-Workspace-Id`. Full OpenAPI at **`/docs`** (JSON at `/docs/json`).

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/signup` `/auth/login` `/auth/refresh` (rotating, reuse-detecting) `/auth/logout` `/auth/accept-invite`, `GET /auth/invites/:token`, `GET/PATCH /me`, `POST /me/password`, `POST /workspaces` |
| Workspace | `GET/PATCH /workspace`, `GET/PATCH /workspace/settings`, `GET/POST /members`, `PATCH/DELETE /members/:id` |
| Chat | `GET/POST /threads`, `GET/PATCH/DELETE /threads/:id`, `POST /threads/:id/messages`, `PATCH /messages/:id/harden`, `POST /files`, `GET /artifacts/:id(/content)` |
| Runs | `GET /runs`, `GET /runs/:id` (with step log), `POST /runs/:id/cancel` |
| Realtime | `GET /events/stream?threadId=&runId=` (SSE, resumable with `Last-Event-ID`) |
| Approvals | `GET /approvals?status=`, `GET /approvals/:id`, `POST /approvals/:id/decision` |
| Integrations | `GET /apps`, `GET/POST /connections`, `PATCH/DELETE /connections/:appId`, `POST /connections/:appId/test`, `GET/POST/DELETE /mcp-servers`, `POST /mcp-servers/:id/check` |
| Workers | `GET /templates`, `POST /workers/draft` (Autopilot), `GET/POST /workers` (from template, description, chat thread, or blank), `GET/PATCH/DELETE /workers/:id`, `POST /workers/:id/{duplicate,publish,status,runs}`, `GET /workers/:id/{versions,runs}`, `POST /workers/:id/versions/:v/restore`, `GET/PUT /workers/:id/evals`, `POST /workers/:id/evals/run`, `POST /hooks/workers/:id` (signed trigger) |
| Work queue & inbox | `GET/POST /workers/:id/queue`, `PATCH /queue/:id`, `GET/POST /inbox`, `GET/PATCH /inbox/:id`, `POST /inbox/:id/{take,reply,resolve}` |
| Knowledge & memory | `GET/POST /knowledge-bases`, `GET/PATCH/DELETE /knowledge-bases/:id`, `POST /knowledge-bases/:id/{sources,documents}`, `POST /knowledge/search`, `GET/POST/PATCH/DELETE /memories`, `GET/POST/DELETE /skills`, `GET /skill-packs`, `POST /skill-packs/:name/{install,uninstall}` |
| Governance | `GET/POST/PATCH/DELETE /policies`, `POST /policies/evaluate`, `GET /audit` (JSON or `?format=csv`), `GET /audit/verify` |
| Developers | `GET/POST/DELETE /api-keys`, `GET/POST/PATCH/DELETE /webhooks`, `POST /webhooks/:id/test`, `GET /webhooks/:id/deliveries` |
| Ops | `GET /billing`, `GET /billing/ledger`, `POST /billing/topup`, `GET /analytics/overview`, `GET /notifications`, `POST /notifications/read` |

**SSE event types:** `thread.created|updated|deleted`, `message.created|updated`, `run.created|updated`,
`approval.created|updated`, `notification.created`, `connection.updated|deleted`, `queue.updated`,
`inbox.updated`, `billing.updated`. Browsers can pass `?access_token=` because `EventSource` can't set headers.

**Webhooks** (outbound and the Worker trigger endpoint) are signed:
`Anvita-Signature: t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<raw body>")>`. Reject timestamps older than 5 minutes.

## Roles

`owner > admin > builder > member > viewer`. Members chat, decide approvals they qualify for and
work the inbox; builders manage Workers, knowledge and connections; admins manage members,
policies, API keys, webhooks, audit and billing. The approver role required by a policy comes from
its `approvers` field (e.g. "Owner"). API keys act with builder rights limited to their scopes
(`all`, `chat`, `workers:run`, `kb:read`, `approvals`, …).

## Security

- Passwords: scrypt. Refresh tokens: random, stored as SHA-256, rotated on every use with reuse detection.
- Access tokens: HS256 JWT, 15 min. API keys: shown once, stored as SHA-256.
- Connection credentials and MCP tokens: AES-256-GCM at rest; never returned by the API or shown to the model.
- Every tenant query is scoped by `workspace_id`; cross-workspace access returns 404/403 (covered by tests).
- Prompt-injection defence: tool outputs are wrapped as untrusted, and policy enforcement doesn't depend on the model.
- Audit log is append-only and hash-chained per workspace (`GET /v1/audit/verify`).
- Helmet headers, CORS allow-list, rate limiting (stricter on auth), request IDs, log redaction, generated HTML artifacts served with `CSP: sandbox`.
- Production boot fails if `JWT_SECRET` / `ENCRYPTION_KEY` are left at their defaults.

## Testing

```bash
createdb anvita_test     # or set TEST_DATABASE_URL
npm test                 # 47 integration + unit tests against real Postgres
npm run typecheck
```

The suite covers auth (rotation/reuse), invites and RBAC, tenant isolation, the full agent
lifecycle (connect → approve/edit → resume; reject; deny; cancel; out-of-credits), knowledge and
memory, file attachments, Workers (templates, publish/version/restore, pause, duplicate, Autopilot,
save-from-chat, exactly-once schedules, evals, signed webhook triggers), work queue and inbox, API key
scopes/revocation, signed outbound webhooks, OpenAPI and health checks.

## Deployment

- The web app's live-mode e2e suite (`npm run test:e2e:live` in the frontend) exercises this API end to end in a browser.
- `Dockerfile` builds a non-root image; `docker-compose.yml` runs Postgres + `api` + `worker`.
- Migrations run on boot (`MIGRATE_ON_START=true`) or as a release step (`npm run db:migrate`). Generate new ones with `npm run db:generate` after editing `src/db/schema.ts`; CI checks they are in sync.
- Scale the API horizontally (SSE fan-out uses Postgres `LISTEN/NOTIFY`); scale workers by replicas and `JOBS_CONCURRENCY`. Graceful shutdown drains in-flight jobs.
- Health: `/healthz` (liveness), `/readyz` (database).

## What's next

Built to the MVP slice of the architecture doc; these pieces are stubbed or still to come:

- **Live connectors:** Slack is live; others use the demo driver. Next: OAuth via an aggregator (Composio/Pipedream) plus native Google Workspace, HubSpot, Shopify, Razorpay drivers.
- **Payments:** top-ups are recorded manually by admins; Stripe/Razorpay checkout plugs into `POST /billing/topup`.
- **SSO/SCIM** (WorkOS), **channel gateways** (Slack events, WhatsApp Cloud API inbound), **MCP tool execution** (servers are registered and health-checked, tools not yet called).
- **Sandbox** code execution (E2B) — artifacts are currently generated content (Markdown/CSV/JSON/HTML), not rendered PDFs/XLSX.
- **Deterministic graph interpreter** — Worker runs currently execute their graph through the agent runtime, guided by the node list; a node-by-node interpreter (and Temporal) is the next step.
- Embeddings + reranking for knowledge search (FTS today), Postgres RLS as defence-in-depth, OpenTelemetry tracing.
