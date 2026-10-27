import type { Facts } from "../policy.js";

export type SideEffect = "none" | "write" | "external" | "destructive";
export type StepKind = "plan" | "tool" | "code" | "llm" | "approval" | "auth" | "kb";

export interface ToolContext {
  workspaceId: string;
  runId: string;
  threadId: string | null;
  actor: { type: "agent" | "worker"; name: string };
  onBehalfOf: { userId: string | null; name: string };
  workspaceDomains: string[];
  /** Decrypted connection credentials for the tool's app (never shown to the model). */
  credentials: Record<string, unknown> | null;
}

export interface ToolResult {
  /** JSON returned to the model as the tool_result (treated as untrusted data). */
  output: unknown;
  /** Short human summary shown in the step timeline, e.g. "148 records". */
  summary: string;
  credits?: number;
  artifactId?: string;
  sources?: { title: string; appId: string }[];
}

export type ApprovalPreview =
  | { kind: "email"; to: string[]; subject: string; body: string }
  | { kind: "fields"; record: string; changes: { field: string; from: string; to: string }[] }
  | { kind: "payment"; payee: string; amount: string; reference: string };

export interface ToolDef<I = any> {
  /** Name exposed to the model (^[a-zA-Z0-9_-]{1,64}$). */
  name: string;
  /** Canonical dotted action used by policies and audit, e.g. `gmail.send`. */
  action: string;
  appId: string;
  kind: StepKind;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  sideEffect: SideEffect;
  /** Whether a healthy connection to `appId` is required before running. */
  needsConnection: boolean;
  label: (input: I) => string;
  facts?: (input: I, ctx: ToolContext) => Facts;
  approval?: (input: I, ctx: ToolContext) => { title: string; preview: ApprovalPreview; risk: "low" | "medium" | "high" };
  execute: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}
