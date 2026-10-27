/**
 * API contract shared with the web app (mirrors apps/web/src/lib/types.ts in anvita-ai-workers).
 * Response serializers are typed against these so the frontend can swap its mock store for the API.
 */
export type Role = "owner" | "admin" | "builder" | "member" | "viewer";

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "active" | "invited";
  lastActive: string;
  sso?: boolean;
}

export type AppCategory =
  | "Productivity"
  | "CRM & Sales"
  | "Support"
  | "Marketing"
  | "Finance"
  | "Engineering"
  | "Commerce"
  | "HR"
  | "Communication"
  | "Data";

export interface AppDef {
  id: string;
  name: string;
  category: AppCategory;
  color: string;
  glyph: string;
  description: string;
  provider: "native" | "aggregator" | "mcp";
  popular?: boolean;
}

export interface Connection {
  appId: string;
  scope: "workspace" | "user" | "shared";
  connectedBy: string;
  connectedAt: string;
  status: "healthy" | "expired" | "error";
  sharedWith?: string[];
  actionsUsed30d: number;
}

export type StepStatus = "pending" | "running" | "done" | "waiting" | "error" | "skipped";

export interface RunStep {
  id: string;
  label: string;
  detail?: string;
  kind: "plan" | "tool" | "code" | "llm" | "approval" | "auth" | "kb";
  appId?: string;
  status: StepStatus;
  durationMs?: number;
  credits?: number;
}

export interface Artifact {
  id: string;
  kind: "pdf" | "sheet" | "chart" | "dashboard" | "doc" | "app";
  title: string;
  subtitle?: string;
  size?: string;
  createdAt?: string;
}

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "plan"; steps: string[]; estimate: number; actual?: number }
  | { type: "steps"; steps: RunStep[] }
  | { type: "connect"; appId: string; status: "pending" | "connected" }
  | { type: "approval"; approvalId: string }
  | { type: "artifact"; artifact: Artifact }
  | { type: "harden"; workerName: string; status: "offered" | "saved" | "dismissed" }
  | { type: "sources"; sources: { title: string; appId: string }[] }
  | { type: "suggestions"; items: string[] };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  author: string;
  time: string;
  blocks: ChatBlock[];
  streaming?: boolean;
}

export interface Thread {
  id: string;
  title: string;
  channel: "web" | "slack" | "whatsapp" | "teams";
  channelLabel?: string;
  updatedAt: string;
  pinned?: boolean;
  unread?: boolean;
  status?: "running" | "waiting" | "done";
  messages: ChatMessage[];
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  title: string;
  action: string;
  appId: string;
  requestedBy: { type: "agent" | "worker"; name: string };
  onBehalfOf: string;
  reason: string;
  risk: "low" | "medium" | "high";
  createdAt: string;
  expiresIn: string;
  status: ApprovalStatus;
  credits: number;
  preview: { kind: "email"; to: string[]; subject: string; body: string } | { kind: "fields"; record: string; changes: { field: string; from: string; to: string }[] } | { kind: "payment"; payee: string; amount: string; reference: string };
  threadId?: string;
  decidedBy?: string;
}

export type NodeKind =
  | "trigger"
  | "agent"
  | "tool"
  | "code"
  | "branch"
  | "map"
  | "approval"
  | "call_worker"
  | "send"
  | "handoff"
  | "kb"
  | "end";

export interface WorkerNode {
  id: string;
  kind: NodeKind;
  title: string;
  subtitle?: string;
  appId?: string;
  x: number;
  y: number;
  config?: Record<string, string | number | boolean | string[]>;
}

export interface WorkerEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export type InteractionType = "chat" | "queue" | "voice" | "api" | "document" | "scheduled";

export interface Worker {
  id: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  interaction: InteractionType;
  channels: string[];
  status: "live" | "draft" | "paused" | "canary";
  version: number;
  owner: string;
  apps: string[];
  trigger: string;
  runs30d: number;
  successRate: number;
  automationRate?: number;
  avgCredits: number;
  hoursSaved30d: number;
  lastRun: string;
  createdFrom?: "template" | "run" | "autopilot" | "scratch";
  pinned?: boolean;
  nodes: WorkerNode[];
  edges: WorkerEdge[];
}

export interface Template {
  id: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  category: string;
  apps: string[];
  interaction: InteractionType;
  installs: string;
  popular?: boolean;
}

export interface QueueItem {
  id: string;
  ref: string;
  title: string;
  source: string;
  status: "needs_review" | "processing" | "done" | "failed" | "escalated";
  confidence: number;
  amount?: string;
  assignee?: string;
  updatedAt: string;
  fields: { label: string; value: string; confidence?: number }[];
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  sources: { appId: string; label: string; docs: number; status: "synced" | "syncing" | "error"; lastSync: string }[];
  docs: number;
  chunks: number;
  usedBy: string[];
  updatedAt: string;
}

export interface MemoryItem {
  id: string;
  scope: "workspace" | "user" | "worker";
  type: "fact" | "preference" | "glossary" | "person" | "process";
  content: string;
  source: string;
  learnedAt: string;
  uses: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  author: "anvita" | "user" | "pack";
  pack?: string;
  uses: number;
  tools: string[];
}

export interface Policy {
  id: string;
  name: string;
  appliesTo: string;
  condition: string;
  effect: "allow" | "approve" | "deny";
  approvers?: string;
  enabled: boolean;
  hits30d: number;
}

export interface AuditEvent {
  id: string;
  time: string;
  actor: string;
  actorType: "user" | "agent" | "worker" | "system";
  action: string;
  target: string;
  channel: string;
  ip?: string;
}

export interface InboxConversation {
  id: string;
  customer: string;
  phone: string;
  channel: "whatsapp" | "voice" | "widget";
  worker: string;
  reason: string;
  sentiment: "negative" | "neutral" | "positive";
  language: string;
  waiting: string;
  summary: string;
  transcript: { from: "customer" | "worker" | "agent"; text: string; time: string }[];
}

export interface RunRecord {
  id: string;
  worker: string;
  trigger: string;
  status: "succeeded" | "failed" | "running" | "waiting_approval";
  startedAt: string;
  duration: string;
  credits: number;
  steps: number;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  createdAt: string;
  lastUsed: string;
  revoked?: boolean;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}

export interface AppNotification {
  id: string;
  appId: string;
  title: string;
  meta: string;
  href: string;
  read: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: "oauth" | "bearer" | "none";
  tools: number;
  status: "healthy" | "error";
}

export interface Profile {
  name: string;
  email: string;
  title: string;
  language: "en" | "hi";
  timezone: string;
  approvalChannel: "slack" | "whatsapp" | "email";
  digest: "daily" | "weekly" | "off";
  quietHours: boolean;
}

export interface EvalCase {
  id: string;
  input: string;
  expected: string;
  category: string;
  score: number;
  pass: boolean;
  ms: number;
}
