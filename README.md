# Anvita AI Workers — Backend

The API and agent runtime behind the [Anvita web app](https://github.com/glalit52/anvita-ai-workers).
It turns the frontend's mock store into a real multi-tenant service: auth, SSO (Google, Microsoft,
SAML) and SCIM provisioning, chat with a Claude-powered agent that pulls data, runs code and takes
governed actions, AI Workers that execute their Studio workflow graph step by step (versions,
schedules, webhooks, evals), live connectors for every catalog app plus MCP servers and imported
OpenAPI specs, a code sandbox, approvals, hybrid knowledge search, memory, policies, audit, billing
credits, realtime streaming and Postgres row-level security.

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

### Workflow engine ([`src/workflow`](src/workflow))

Graph Workers (`engine: "graph"`, the default) execute their Studio graph node by node instead of
handing it to the model as guidance:

- **Steps:** trigger · AI agent (instructions, model tier, allowed tools, knowledge, JSON output
  schema validated with retries, optional human review) · app action (any registered action, MCP or
  imported API; inputs mapped with expressions or filled by AI from earlier steps; retries) · code
  (Python/JS in the sandbox) · branch (rules or AI routing) · loop/map (per item: action, AI step,
  code or another Worker, with concurrency) · approval (condition, approvers, timeout → reject or
  escalate) · call Worker · send (reply in the same conversation, Slack, Teams, WhatsApp, Gmail,
  Outlook, signed webhook) · human handoff · knowledge search · end.
- **Semantics:** independent steps run in parallel; a step runs once all its inputs have settled
  and at least one incoming path was taken, so branches and rejected approvals prune whole paths
  and joins wait for fan-outs. Errors can stop the run or follow an `error` path (`onError: continue`).
- **Data:** `{{ … }}` expressions over `trigger`, `steps.<id>` (or a slug of the step title),
  `item`/`index` in loops, with functions like `sum`, `len`, `pluck`, `where`, `inr`, `days_ago`.
  Conditions use the same language (`intent = return_refund and amount > 5000`, `confidence ≥ 95%`).
- **Durability:** all state lives in `runs.state`; a run waits for connections, approvals or called
  Workers and resumes on any instance. `GET /v1/runs/:id/trace` shows each step's status, output
  and the paths taken.
- **Validation:** `POST /v1/workers/:id/validate` checks loops, missing actions, unmapped inputs,
  bad expressions and references to steps that haven't run yet; publishing is blocked on errors.
  `GET /v1/workflow/catalog` lists every action with its input schema for the Studio.
- **Templates:** 16 executable templates (support, weekly report, invoice → Tally, IT helpdesk, lead
  research, onboarding, RFP answers, recruiting, collections, COD confirmation, ticket triage,
  low stock, GST summary, engineering digest, pipeline review, ad-spend guardrail).

### Code sandbox ([`src/sandbox`](src/sandbox))

Agents (`run_code` tool) and code steps run Python (pandas, numpy, matplotlib, openpyxl, fpdf2) or
JavaScript in a throwaway environment with **no network**:

- `SANDBOX_PROVIDER=docker` (production default): one container per run — `--network none`,
  read-only root, tmpfs work dir, non-root user, dropped capabilities, CPU/memory/pid limits,
  timeout. Build the image with `docker build -t anvita-sandbox:latest sandbox`.
- `process` (development): the local interpreter in a network-less user namespace with rlimits.
- Code calls workspace tools through a line protocol on stdin/stdout (`tools.hubspot.deals.search(...)`),
  checked by the same connection and policy gateway as the agent — reads and allowed writes run,
  anything needing approval is refused. Files written with `files.csv/excel/pdf/chart/save` become
  downloadable artifacts.

### Connectors ([`src/connectors`](src/connectors))

Every app action runs through one connector layer: a **live driver** when the workspace has
credentials for the app, otherwise a clearly-labelled **demo driver** (results say "demo data"),
so flows work before apps are set up.

- **Auth:** OAuth 2.0 authorization-code flow (`POST /v1/connections/:appId/authorize` →
  provider → `GET /v1/oauth/callback`, signed state, automatic token refresh) for Google
  Workspace, Microsoft 365, Slack, HubSpot, Salesforce, Shopify, Zendesk, Notion and GitHub;
  API keys / tokens for Slack, WhatsApp Cloud API, Meta Ads, HubSpot, Shopify, Zendesk,
  Freshdesk, Intercom, Razorpay, Stripe, Delhivery, Mailchimp, Notion, GitHub, Jira, Linear and
  Okta. Credentials are verified with a live call before they're saved and stored AES-256-GCM
  encrypted; the API shows only `mode` (live/demo), the connected account and health.
- **Live drivers:** Gmail (send, search), Google Calendar, Drive, Sheets (read, append), GA4,
  Outlook (send, search), Slack (post, channels), WhatsApp (send), Meta Ads insights, HubSpot
  deals (search, update), Salesforce SOQL (read-only), Shopify orders, Razorpay (payments,
  refunds), Stripe (payments, refunds), Delhivery tracking, Zendesk (search, create), Freshdesk,
  Intercom, Mailchimp, Notion search, GitHub issues (search, create), Jira (search, create),
  Linear, Okta (users, password reset, group access), Google Ads (GAQL), Microsoft Teams (channels,
  post), Tally Prime (vouchers export/create, ledgers — XML over an HTTPS gateway), QuickBooks
  (query, bills), Zoho CRM + Books, Darwinbox (employees, leave), Workday (workers, time off),
  BigQuery and PostgreSQL (read-only SQL), Shopify orders/products/customers, HubSpot contacts,
  Google Calendar events and free/busy, Gmail drafts, Zendesk updates, Razorpay payment links and
  WhatsApp templates. Every catalog app has a live driver.
- **Custom APIs:** `POST /v1/custom-apis` imports an OpenAPI 3 / Swagger 2 spec (pasted or by URL,
  `$ref`s resolved); each operation becomes a tool `api.<slug>.<operation>` with the API's auth
  (bearer, header or query key, basic). GETs are read-only; other methods go through policies.
- **SSRF guard:** user-supplied URLs (webhooks, imported APIs, web fetch, MCP) must be https and,
  in production, resolve to public addresses.
- **MCP servers:** Streamable-HTTP MCP servers are initialized and their tools listed on add;
  the agent calls them as `mcp_<server>_<tool>`, with policies applied from each tool's
  annotations (read-only runs freely; destructive or unannotated tools go through approvals).

Built-in agent tools: `share_plan`, `kb_search` (cited knowledge search), `memory_search`,
`memory_save`, `create_artifact`, `run_code`, `web_fetch`, and `handoff_to_human` in customer
conversations.

### Knowledge search ([`src/services/knowledge.ts`](src/services/knowledge.ts))

Hybrid retrieval: Postgres full-text search plus pgvector nearest neighbours (1024-dim embeddings
from Voyage `voyage-3.5` or OpenAI `text-embedding-3-small`, HNSW index), merged with reciprocal
rank fusion; each hit says whether it matched by keyword, meaning or both. Documents are embedded
in the background after upload, with a periodic catch-up and `POST /v1/knowledge/reindex`;
`GET /v1/knowledge/status` reports coverage. Without pgvector or an embeddings key, search is
keyword-only.

### Channels ([`src/channels`](src/channels))

- **Slack:** point the Slack app's Event Subscriptions at `/v1/hooks/slack/events` (signed, deduped).
  @mentions and DMs start a run in a thread that mirrors the Slack thread; the answer, file links
  and approval/connect notices are posted back into the Slack thread.
- **WhatsApp Cloud API:** webhook `/v1/hooks/whatsapp` (verify token + `X-Hub-Signature-256`).
  Customer messages are answered by the live Worker bound to WhatsApp with a customer-safe prompt
  and tool set. `handoff_to_human` moves the conversation to the Inbox; while a teammate has it,
  customer messages go to the Inbox and replies from the Inbox are delivered on WhatsApp.

### Payments and sign-in

- **Credits checkout:** `POST /v1/billing/checkout` creates a Razorpay order (completed with
  Razorpay Checkout and `POST /v1/billing/razorpay/verify`) or a Stripe Checkout session.
  Signed webhooks (`/v1/hooks/razorpay`, `/v1/hooks/stripe`) grant credits exactly once.
- **SSO:** `GET /v1/auth/sso/{google|microsoft}/start` → OpenID Connect with ID tokens verified
  against the provider's JWKS (audience, issuer, nonce). First sign-in creates the account and a
  workspace, or joins pending invites for that email.
- **SAML 2.0** (Okta, Entra ID, Google Workspace, OneLogin…): per-workspace IdP settings
  (`PUT /v1/workspace/sso`, or paste IdP metadata into `/v1/workspace/sso/parse-metadata`);
  SP metadata at `/v1/auth/saml/:workspaceId/metadata`, ACS at `/v1/auth/saml/:workspaceId/acs`.
  Assertions must be signed by the IdP certificate and are checked for audience, time window and
  replay. Email domains route the login page to the IdP (`GET /v1/auth/sso/discover`), new people
  can be created on first sign-in with a default role, and SSO can be enforced (password sign-in
  refused for those domains).
- **SCIM 2.0** at `/v1/scim/v2` (bearer token from `POST /v1/workspace/scim-token`): Users
  (create, filter by userName/externalId, replace, PATCH including `active`, delete) and Groups
  mapped to roles (Admins, Builders, Members, Viewers), so the IdP provisions, deprovisions and
  assigns roles.

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
| Runs | `GET /runs`, `GET /runs/:id` (step log, workflow trace, output), `GET /runs/:id/trace`, `POST /runs/:id/cancel` |
| Realtime | `GET /events/stream?threadId=&runId=` (SSE, resumable with `Last-Event-ID`) |
| Approvals | `GET /approvals?status=`, `GET /approvals/:id`, `POST /approvals/:id/decision` |
| Integrations | `GET /apps`, `GET/POST /connections`, `PATCH/DELETE /connections/:appId`, `POST /connections/:appId/{authorize,test}`, `GET/POST/PATCH/DELETE /mcp-servers`, `POST /mcp-servers/:id/check`, `GET/POST/PATCH/DELETE /custom-apis`, `POST /custom-apis/preview`, `POST /custom-apis/:id/try` |
| Workers | `GET /templates`, `POST /workers/draft` (Autopilot), `GET/POST /workers` (from template, description, chat thread, or blank), `GET/PATCH/DELETE /workers/:id`, `POST /workers/:id/{duplicate,publish,status,runs}`, `GET /workers/:id/{versions,runs}`, `POST /workers/:id/versions/:v/restore`, `POST /workers/:id/validate`, `GET /workflow/catalog`, `GET/PUT /workers/:id/evals`, `POST /workers/:id/evals/run`, `POST /hooks/workers/:id` (signed trigger) |
| Work queue & inbox | `GET/POST /workers/:id/queue`, `PATCH /queue/:id`, `GET/POST /inbox`, `GET/PATCH /inbox/:id`, `POST /inbox/:id/{take,reply,resolve}` |
| Knowledge & memory | `GET/POST /knowledge-bases`, `GET/PATCH/DELETE /knowledge-bases/:id`, `POST /knowledge-bases/:id/{sources,documents}`, `POST /knowledge/search`, `GET /knowledge/status`, `POST /knowledge/reindex`, `GET/POST/PATCH/DELETE /memories`, `GET/POST/DELETE /skills`, `GET /skill-packs`, `POST /skill-packs/:name/{install,uninstall}` |
| Governance | `GET/POST/PATCH/DELETE /policies`, `POST /policies/evaluate`, `GET /audit` (JSON or `?format=csv`), `GET /audit/verify` |
| Developers | `GET/POST/DELETE /api-keys`, `GET/POST/PATCH/DELETE /webhooks`, `POST /webhooks/:id/test`, `GET /webhooks/:id/deliveries` |
| Enterprise identity | `GET/PUT /workspace/sso`, `POST /workspace/sso/parse-metadata`, `POST/DELETE /workspace/scim-token`, `GET /auth/sso/discover`, `/auth/saml/:ws/{metadata,login,acs}`, `/scim/v2/{ServiceProviderConfig,ResourceTypes,Schemas,Users,Groups}` |
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
- **Row-level security** as a second line: workspace-scoped requests run in a transaction as the
  restricted `anvita_tenant` role with `app.workspace_id` set, and every table with a
  `workspace_id` has a policy, so even an unfiltered query only sees that workspace. Responses are
  sent after the transaction commits. Migrations need a role that can `CREATE ROLE` (otherwise the
  API logs a warning and runs without RLS); `RLS_ENABLED=false` turns it off.
- Code runs in a network-less sandbox; user-supplied URLs are SSRF-checked.
- Prompt-injection defence: tool outputs are wrapped as untrusted, and policy enforcement doesn't depend on the model.
- Audit log is append-only and hash-chained per workspace (`GET /v1/audit/verify`).
- Helmet headers, CORS allow-list, rate limiting (stricter on auth), request IDs, log redaction, generated HTML artifacts served with `CSP: sandbox`.
- Production boot fails if `JWT_SECRET` / `ENCRYPTION_KEY` are left at their defaults.

## Testing

```bash
createdb anvita_test     # or set TEST_DATABASE_URL
npm test                 # 141 integration + unit tests against real Postgres (with pgvector)
npm run typecheck
```

The suite covers auth (rotation/reuse), invites and RBAC, tenant isolation, the full agent
lifecycle (connect → approve/edit → resume; reject; deny; cancel; out-of-credits), knowledge and
memory, file attachments, Workers (templates, publish/version/restore, pause, duplicate, Autopilot,
save-from-chat, exactly-once schedules, evals, signed webhook triggers), the workflow engine
(branches, joins, approvals, code with tools and files, loops, called Workers, connection waits,
validation, every template), the sandbox, all 60+ live drivers against mocked provider APIs (plus
read-only SQL against real Postgres), OpenAPI import, hybrid search, row-level security, SAML
(signed assertions, replay, tampering, wrong audience, enforcement) and SCIM, work queue and
inbox, API key scopes/revocation, signed outbound webhooks, OpenAPI and health checks.

## Deployment

- The web app's live-mode e2e suite (`npm run test:e2e:live` in the frontend) exercises this API end to end in a browser.
- `Dockerfile` builds a non-root image; `docker-compose.yml` runs Postgres + `api` + `worker`.
- Migrations run on boot (`MIGRATE_ON_START=true`) or as a release step (`npm run db:migrate`). Generate new ones with `npm run db:generate` after editing `src/db/schema.ts`; CI checks they are in sync.
- Scale the API horizontally (SSE fan-out uses Postgres `LISTEN/NOTIFY`); scale workers by replicas and `JOBS_CONCURRENCY`. Graceful shutdown drains in-flight jobs.
- Health: `/healthz` (liveness), `/readyz` (database).

## What's next

- Long-tail apps through an aggregator (Composio/Pipedream); interactive MCP OAuth (servers take a bearer token today).
- Teams as an inbound channel, Slack interactive approval buttons, SAML single logout.
- Temporal (or similar) for very long-running workflows; OpenTelemetry tracing; reranking on top of hybrid search.
