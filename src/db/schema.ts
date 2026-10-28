import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Every tenant-owned table carries `workspace_id`; all queries are scoped by it in the
 * service layer. Ids are prefixed strings (e.g. `wrk_…`) so they are self-describing in logs/APIs.
 */

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

export type Role = "owner" | "admin" | "builder" | "member" | "viewer";

// ─── Identity & tenancy ────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  title: text("title").notNull().default(""),
  language: text("language").notNull().default("en"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  approvalChannel: text("approval_channel").notNull().default("email"),
  digest: text("digest").notNull().default("daily"),
  quietHours: boolean("quiet_hours").notNull().default(false),
  lastActiveAt: ts("last_active_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)]);

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  plan: text("plan").notNull().default("Business"),
  region: text("region").notNull().default("India (Mumbai)"),
  /** Email domains considered internal (used by policies, e.g. external email approval). */
  domains: text("domains").array().notNull().default(sql`'{}'::text[]`),
  settings: jsonb("settings").$type<Record<string, string | number | boolean>>().notNull().default({}),
  installedPacks: text("installed_packs").array().notNull().default(sql`'{}'::text[]`),
  renewsAt: ts("renews_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("workspaces_slug_uq").on(t.slug)]);

export const memberships = pgTable("memberships", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: text("role").$type<Role>().notNull(),
  status: text("status").$type<"active" | "invited">().notNull().default("active"),
  sso: boolean("sso").notNull().default(false),
  inviteTokenHash: text("invite_token_hash"),
  invitedBy: text("invited_by"),
  lastActiveAt: ts("last_active_at"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("memberships_ws_email_uq").on(t.workspaceId, sql`lower(${t.email})`),
  index("memberships_user_idx").on(t.userId),
]);

export const refreshTokens = pgTable("refresh_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("refresh_tokens_hash_uq").on(t.tokenHash)]);

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  scope: text("scope").notNull(),
  createdBy: text("created_by"),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash), index("api_keys_ws_idx").on(t.workspaceId)]);

// ─── Integrations ──────────────────────────────────────────────────────────────

export const connections = pgTable("connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull(),
  scope: text("scope").$type<"workspace" | "user" | "shared">().notNull().default("workspace"),
  ownerUserId: text("owner_user_id"),
  connectedByName: text("connected_by_name").notNull(),
  status: text("status").$type<"healthy" | "expired" | "error">().notNull().default("healthy"),
  sharedWith: text("shared_with").array().notNull().default(sql`'{}'::text[]`),
  /** AES-256-GCM encrypted JSON credentials (never returned by the API, never sent to the model). */
  credentialsEnc: text("credentials_enc"),
  /** live = real credentials (OAuth or API key); demo = sample-data driver. */
  mode: text("mode").$type<"live" | "demo">().notNull().default("demo"),
  /** Human label of the connected account (Slack team, shop domain, email…). */
  account: text("account"),
  /** Provider-side id used to route inbound events (Slack team id, WhatsApp phone number id). */
  externalId: text("external_id"),
  /** Last health-check outcome shown in the UI. */
  statusDetail: text("status_detail"),
  actionsUsed30d: integer("actions_used_30d").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("connections_ws_app_uq").on(t.workspaceId, t.appId), index("connections_external_idx").on(t.appId, t.externalId)]);

export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  auth: text("auth").$type<"oauth" | "bearer" | "none">().notNull().default("none"),
  tokenEnc: text("token_enc"),
  tools: integer("tools").notNull().default(0),
  /** Tool definitions discovered via tools/list (refreshed on check). */
  toolDefs: jsonb("tool_defs").$type<{ name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  lastError: text("last_error"),
  lastCheckedAt: ts("last_checked_at"),
  status: text("status").$type<"healthy" | "error">().notNull().default("healthy"),
  createdAt: createdAt(),
});

export interface ApiOperation {
  id: string;
  method: string;
  path: string;
  summary: string;
  params: { name: string; in: "path" | "query" | "header"; required: boolean; description?: string; schema?: Record<string, unknown> }[];
  body?: Record<string, unknown> | null;
  sideEffect: "none" | "write" | "external" | "destructive";
  enabled: boolean;
}

/** Internal / third-party REST APIs imported from an OpenAPI spec and exposed as tools. */
export const customApis = pgTable("custom_apis", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  baseUrl: text("base_url").notNull(),
  authType: text("auth_type").$type<"none" | "bearer" | "header" | "query" | "basic">().notNull().default("none"),
  /** Header or query parameter name for API-key auth. */
  authName: text("auth_name"),
  secretEnc: text("secret_enc"),
  operations: jsonb("operations").$type<ApiOperation[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("custom_apis_ws_slug_uq").on(t.workspaceId, t.slug)]);

// ─── Conversations & runs ──────────────────────────────────────────────────────

export const threads = pgTable("threads", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdBy: text("created_by"),
  title: text("title").notNull(),
  channel: text("channel").$type<"web" | "slack" | "whatsapp" | "teams">().notNull().default("web"),
  channelLabel: text("channel_label"),
  pinned: boolean("pinned").notNull().default(false),
  unread: boolean("unread").notNull().default(false),
  status: text("status").$type<"running" | "waiting" | "done">().notNull().default("done"),
  workerId: text("worker_id"),
  /** Channel conversation this thread mirrors, e.g. `slack:C123:1700.1` or `wa:<phone id>:<customer>`. */
  externalRef: text("external_ref"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("threads_ws_updated_idx").on(t.workspaceId, t.updatedAt), uniqueIndex("threads_external_uq").on(t.workspaceId, t.externalRef)]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  role: text("role").$type<"user" | "assistant">().notNull(),
  author: text("author").notNull(),
  authorId: text("author_id"),
  blocks: jsonb("blocks").$type<unknown[]>().notNull().default([]),
  streaming: boolean("streaming").notNull().default(false),
  runId: text("run_id"),
  createdAt: createdAt(),
}, (t) => [index("messages_thread_idx").on(t.threadId, t.createdAt)]);

export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting_auth" | "succeeded" | "failed" | "cancelled";

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"agent" | "worker" | "test">().notNull(),
  threadId: text("thread_id"),
  workerId: text("worker_id"),
  workerVersion: integer("worker_version"),
  trigger: text("trigger").notNull().default("chat"),
  status: text("status").$type<RunStatus>().notNull().default("queued"),
  assistantMessageId: text("assistant_message_id"),
  createdBy: text("created_by"),
  createdByName: text("created_by_name"),
  input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
  /** Durable agent state: LLM transcript + pending tool calls. Lets a run pause for days and resume on any instance. */
  state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
  estimateCredits: integer("estimate_credits"),
  creditsUsed: integer("credits_used").notNull().default(0),
  stepsCount: integer("steps_count").notNull().default(0),
  /** Assistant-message blocks already posted back to the originating channel (Slack/WhatsApp). */
  deliveredBlocks: integer("delivered_blocks").notNull().default(0),
  /** Set when a workflow's Call Worker / Loop step started this run; the parent resumes when it ends. */
  parentRunId: text("parent_run_id"),
  parentNodeId: text("parent_node_id"),
  error: text("error"),
  startedAt: ts("started_at"),
  endedAt: ts("ended_at"),
  createdAt: createdAt(),
}, (t) => [index("runs_ws_created_idx").on(t.workspaceId, t.createdAt), index("runs_worker_idx").on(t.workerId, t.createdAt), index("runs_parent_idx").on(t.parentRunId)]);

export const runSteps = pgTable("run_steps", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  seq: bigint("seq", { mode: "number" }).notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  label: text("label").notNull(),
  appId: text("app_id"),
  status: text("status").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  model: text("model"),
  tokens: jsonb("tokens"),
  credits: integer("credits").notNull().default(0),
  startedAt: ts("started_at"),
  endedAt: ts("ended_at"),
}, (t) => [index("run_steps_run_idx").on(t.runId, t.seq)]);

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  runId: text("run_id"),
  toolUseId: text("tool_use_id"),
  threadId: text("thread_id"),
  title: text("title").notNull(),
  action: text("action").notNull(),
  appId: text("app_id").notNull(),
  requestedBy: jsonb("requested_by").$type<{ type: "agent" | "worker"; name: string }>().notNull(),
  onBehalfOf: text("on_behalf_of").notNull(),
  reason: text("reason").notNull(),
  risk: text("risk").$type<"low" | "medium" | "high">().notNull().default("medium"),
  credits: integer("credits").notNull().default(0),
  preview: jsonb("preview").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  policyId: text("policy_id"),
  approverRole: text("approver_role").$type<Role>(),
  status: text("status").$type<"pending" | "approved" | "rejected" | "expired">().notNull().default("pending"),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
}, (t) => [index("approvals_ws_status_idx").on(t.workspaceId, t.status, t.createdAt)]);

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  runId: text("run_id"),
  threadId: text("thread_id"),
  kind: text("kind").$type<"pdf" | "sheet" | "chart" | "dashboard" | "doc" | "app">().notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  mime: text("mime").notNull().default("text/plain"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  content: text("content").notNull().default(""),
  createdAt: createdAt(),
});

/** Append-only event log that backs SSE streams (resumable via Last-Event-ID) and cross-instance fan-out. */
export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id"),
  threadId: text("thread_id"),
  runId: text("run_id"),
  type: text("type").notNull(),
  data: jsonb("data").notNull(),
  createdAt: createdAt(),
}, (t) => [index("events_ws_id_idx").on(t.workspaceId, t.id), index("events_created_idx").on(t.createdAt)]);

// ─── Workers (Studio) ──────────────────────────────────────────────────────────

export interface WorkerNode {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  appId?: string;
  x: number;
  y: number;
  config?: Record<string, unknown>;
}
export interface WorkerEdge { id: string; source: string; target: string; label?: string }

export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  instructions: text("instructions").notNull().default(""),
  emoji: text("emoji").notNull().default("🤖"),
  color: text("color").notNull().default("#5B4CF0"),
  interaction: text("interaction").$type<"chat" | "queue" | "voice" | "api" | "document" | "scheduled">().notNull().default("chat"),
  channels: text("channels").array().notNull().default(sql`'{}'::text[]`),
  status: text("status").$type<"live" | "draft" | "paused" | "canary">().notNull().default("draft"),
  version: integer("version").notNull().default(0),
  ownerId: text("owner_id"),
  ownerName: text("owner_name").notNull(),
  apps: text("apps").array().notNull().default(sql`'{}'::text[]`),
  trigger: text("trigger").notNull().default("Manual"),
  /** 5-field cron (UTC) for scheduled workers; evaluated by the scheduler. */
  schedule: text("schedule"),
  createdFrom: text("created_from").$type<"template" | "run" | "autopilot" | "scratch">().notNull().default("scratch"),
  sourceRunId: text("source_run_id"),
  templateId: text("template_id"),
  pinned: boolean("pinned").notNull().default(false),
  /** "graph" executes the Studio graph step by step (deterministic workflow); "agent" lets the model follow it as guidance. */
  engine: text("engine").$type<"graph" | "agent">().notNull().default("graph"),
  nodes: jsonb("nodes").$type<WorkerNode[]>().notNull().default([]),
  edges: jsonb("edges").$type<WorkerEdge[]>().notNull().default([]),
  webhookSecret: text("webhook_secret"),
  lastScheduledAt: ts("last_scheduled_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("workers_ws_idx").on(t.workspaceId)]);

export const workerVersions = pgTable("worker_versions", {
  id: text("id").primaryKey(),
  workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  note: text("note"),
  publishedBy: text("published_by"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("worker_versions_uq").on(t.workerId, t.version)]);

export const evalCases = pgTable("eval_cases", {
  id: text("id").primaryKey(),
  workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  input: text("input").notNull(),
  expected: text("expected").notNull(),
  category: text("category").notNull().default("general"),
  score: real("score").notNull().default(0),
  pass: boolean("pass").notNull().default(false),
  ms: integer("ms").notNull().default(0),
  lastRunAt: ts("last_run_at"),
  createdAt: createdAt(),
});

export const queueItems = pgTable("queue_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
  ref: text("ref").notNull(),
  title: text("title").notNull(),
  source: text("source").notNull(),
  status: text("status").$type<"needs_review" | "processing" | "done" | "failed" | "escalated">().notNull().default("processing"),
  confidence: real("confidence").notNull().default(0),
  amount: text("amount"),
  assignee: text("assignee"),
  fields: jsonb("fields").$type<{ label: string; value: string; confidence?: number }[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("queue_items_worker_idx").on(t.workerId, t.updatedAt)]);

export const inboxConversations = pgTable("inbox_conversations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  workerId: text("worker_id"),
  workerName: text("worker_name").notNull(),
  customer: text("customer").notNull(),
  phone: text("phone").notNull().default(""),
  channel: text("channel").$type<"whatsapp" | "voice" | "widget">().notNull(),
  reason: text("reason").notNull(),
  sentiment: text("sentiment").$type<"negative" | "neutral" | "positive">().notNull().default("neutral"),
  language: text("language").notNull().default("English"),
  summary: text("summary").notNull().default(""),
  transcript: jsonb("transcript").$type<{ from: "customer" | "worker" | "agent"; text: string; time: string }[]>().notNull().default([]),
  status: text("status").$type<"open" | "taken" | "resolved">().notNull().default("open"),
  assigneeId: text("assignee_id"),
  assigneeName: text("assignee_name"),
  notes: text("notes").notNull().default(""),
  /** Thread mirroring the customer conversation; human replies are delivered back through it. */
  threadId: text("thread_id"),
  waitingSince: ts("waiting_since").notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── Knowledge, memory, skills ─────────────────────────────────────────────────

export const knowledgeBases = pgTable("knowledge_bases", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  usedBy: text("used_by").array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const kbSources = pgTable("kb_sources", {
  id: text("id").primaryKey(),
  kbId: text("kb_id").notNull().references(() => knowledgeBases.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  appId: text("app_id").notNull(),
  label: text("label").notNull(),
  status: text("status").$type<"synced" | "syncing" | "error">().notNull().default("synced"),
  error: text("error"),
  lastSyncAt: ts("last_sync_at"),
  createdAt: createdAt(),
});

export const kbDocuments = pgTable("kb_documents", {
  id: text("id").primaryKey(),
  kbId: text("kb_id").notNull().references(() => knowledgeBases.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  sourceId: text("source_id"),
  title: text("title").notNull(),
  mime: text("mime").notNull().default("text/plain"),
  url: text("url"),
  bytes: integer("bytes").notNull().default(0),
  chunks: integer("chunks").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index("kb_documents_kb_idx").on(t.kbId)]);

export const kbChunks = pgTable("kb_chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => kbDocuments.id, { onDelete: "cascade" }),
  kbId: text("kb_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  seq: integer("seq").notNull(),
  content: text("content").notNull(),
  tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', content)`),
}, (t) => [index("kb_chunks_tsv_idx").using("gin", t.tsv), index("kb_chunks_ws_kb_idx").on(t.workspaceId, t.kbId)]);

export const memories = pgTable("memories", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  scope: text("scope").$type<"workspace" | "user" | "worker">().notNull().default("workspace"),
  scopeId: text("scope_id"),
  type: text("type").$type<"fact" | "preference" | "glossary" | "person" | "process">().notNull().default("fact"),
  content: text("content").notNull(),
  source: text("source").notNull(),
  sourceRunId: text("source_run_id"),
  uses: integer("uses").notNull().default(0),
  lastUsedAt: ts("last_used_at"),
  createdAt: createdAt(),
}, (t) => [index("memories_ws_idx").on(t.workspaceId)]);

export const skills = pgTable("skills", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  stepsMd: text("steps_md").notNull().default(""),
  author: text("author").$type<"anvita" | "user" | "pack">().notNull().default("user"),
  pack: text("pack"),
  tools: text("tools").array().notNull().default(sql`'{}'::text[]`),
  uses: integer("uses").notNull().default(0),
  createdAt: createdAt(),
});

// ─── Governance ────────────────────────────────────────────────────────────────

export const policies = pgTable("policies", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Comma-separated action globs, e.g. `gmail.send, outlook.send` or `*.delete`. */
  appliesTo: text("applies_to").notNull(),
  /** Condition expression (see runtime/policy.ts), e.g. `amount > 5000`, `external_recipients > 0`, `always`. */
  condition: text("condition").notNull().default("always"),
  effect: text("effect").$type<"allow" | "approve" | "deny">().notNull(),
  approvers: text("approvers"),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull().default(100),
  hits30d: integer("hits_30d").notNull().default(0),
  createdAt: createdAt(),
});

/** Tamper-evident audit log: each row hashes its content plus the previous row's hash (per workspace). */
export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  actor: text("actor").notNull(),
  actorId: text("actor_id"),
  actorType: text("actor_type").$type<"user" | "agent" | "worker" | "system">().notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  channel: text("channel").notNull().default("Web"),
  ip: text("ip"),
  payload: jsonb("payload"),
  prevHash: text("prev_hash"),
  hash: text("hash").notNull(),
  createdAt: createdAt(),
}, (t) => [index("audit_ws_id_idx").on(t.workspaceId, t.id)]);

// ─── Billing & notifications ───────────────────────────────────────────────────

export const creditLedger = pgTable("credit_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  delta: integer("delta").notNull(),
  reason: text("reason").$type<"plan_grant" | "topup" | "usage" | "adjustment" | "refund">().notNull(),
  refType: text("ref_type"),
  refId: text("ref_id"),
  meta: jsonb("meta"),
  createdAt: createdAt(),
}, (t) => [index("credit_ledger_ws_idx").on(t.workspaceId, t.createdAt)]);

export const payments = pgTable("payments", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text("provider").$type<"razorpay" | "stripe">().notNull(),
  /** Razorpay order id or Stripe Checkout session id. */
  providerRef: text("provider_ref"),
  credits: integer("credits").notNull(),
  /** Amount in the currency's minor unit (paise, cents). */
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").$type<"created" | "paid" | "failed">().notNull().default("created"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  paidAt: ts("paid_at"),
}, (t) => [uniqueIndex("payments_provider_ref_uq").on(t.provider, t.providerRef)]);

export const notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  appId: text("app_id").notNull(),
  title: text("title").notNull(),
  meta: text("meta").notNull().default(""),
  href: text("href").notNull().default("/"),
  read: boolean("read").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index("notifications_user_idx").on(t.workspaceId, t.userId, t.createdAt)]);

export const webhooks = pgTable("webhooks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  events: text("events").array().notNull(),
  secret: text("secret").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull().references(() => webhooks.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").$type<"pending" | "delivered" | "failed">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  responseCode: integer("response_code"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  deliveredAt: ts("delivered_at"),
});

/** Inbound channel event ids already processed (providers retry deliveries). */
export const channelEvents = pgTable("channel_events", {
  id: text("id").primaryKey(),
  createdAt: createdAt(),
});

// ─── Durable jobs ──────────────────────────────────────────────────────────────

export const jobs = pgTable("jobs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  runAt: ts("run_at").notNull().defaultNow(),
  lockedAt: ts("locked_at"),
  lockedBy: text("locked_by"),
  lastError: text("last_error"),
  /** Optional de-duplication key: at most one queued/running job per key. */
  dedupeKey: text("dedupe_key"),
  createdAt: createdAt(),
}, (t) => [
  index("jobs_ready_idx").on(t.status, t.runAt),
  uniqueIndex("jobs_dedupe_uq").on(t.dedupeKey).where(sql`${t.dedupeKey} is not null and ${t.status} in ('queued','running')`),
]);
