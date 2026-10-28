import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { artifacts, runs } from "../../db/schema.js";
import { runInSandbox, type SandboxLanguage, type SandboxResult } from "../../sandbox/index.js";
import { artifactBytes, saveFileArtifact } from "../../services/artifacts.js";
import { invokeImmediately, type Run } from "../gateway.js";
import type { ToolDef, ToolResult } from "./types.js";

/** Resolves `tools.<app>.<action>(…)` from sandboxed code to a workspace tool. */
export type ToolResolver = (actionOrName: string) => Promise<ToolDef | undefined>;

export interface CodeRun {
  run: Run;
  language: SandboxLanguage;
  code: string;
  inputs?: unknown;
  fileIds?: string[];
  timeoutMs?: number;
  resolve: ToolResolver;
}

/**
 * Run code in the sandbox on behalf of a run. Tool calls go through the gateway without pausing
 * (reads and policy-allowed writes only); files written to out/ become artifacts.
 */
export async function runCodeForRun(o: CodeRun): Promise<SandboxResult & { artifactIds: string[] }> {
  const inFiles = o.fileIds?.length ? await db.select().from(artifacts).where(and(eq(artifacts.workspaceId, o.run.workspaceId), inArray(artifacts.id, o.fileIds))) : [];
  const res = await runInSandbox({
    language: o.language,
    code: o.code,
    inputs: o.inputs,
    timeoutMs: o.timeoutMs,
    files: inFiles.map((a) => ({ name: a.title, data: artifactBytes(a) })),
    onToolCall: async (action, input) => {
      const tool = await o.resolve(action);
      if (!tool || tool.name === "run_code") throw new Error(`Unknown tool "${action}". Use the dotted action, e.g. tools.hubspot.deals.search(query="…")`);
      return (await invokeImmediately(o.run, tool, input)).output;
    },
  });
  const artifactIds: string[] = [];
  for (const f of res.files) {
    const a = await saveFileArtifact({ workspaceId: o.run.workspaceId, runId: o.run.id, threadId: o.run.threadId, name: f.name, data: f.data, subtitle: "Generated in the sandbox" });
    artifactIds.push(a.id);
  }
  return { ...res, artifactIds };
}

/** Sandbox credit cost: 1 credit per started 5 seconds of compute, minimum 1. */
export const sandboxCredits = (ms: number) => Math.max(1, Math.ceil(ms / 5000));

export function codeTool(resolve: ToolResolver): ToolDef {
  return {
    name: "run_code",
    action: "sandbox.run_code",
    appId: "sandbox",
    kind: "code",
    description:
      "Run Python (pandas, numpy, matplotlib, openpyxl, fpdf2) or JavaScript in an isolated sandbox with no internet. Use it for calculations, data analysis, reconciliation and building real files. " +
      "Inside the code: `inputs` holds what you pass in `inputs`; call workspace tools with `tools.<app>.<action>(...)`, e.g. `tools.hubspot.deals.search(range='last_30d')` (read-only and policy-allowed actions only); " +
      "save deliverables with `files.csv(name, rows_or_df)`, `files.excel(name, df_or_dict)`, `files.chart(name)` (current matplotlib figure), `files.pdf(name, markdown, title=…, data=df)` or `files.save(name, bytes_or_text)` — they're returned to the user. " +
      "Uploaded files passed in `file_ids` are readable with `files.read(name)` or from `files.in_dir`. `return` a JSON-serializable value (Python may also end with an expression).",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "javascript"] },
        code: { type: "string", description: "The program" },
        inputs: { type: "object", description: "Data made available as `inputs`" },
        file_ids: { type: "array", items: { type: "string" }, description: "Artifact ids of uploaded files to make available" },
      },
      required: ["code"],
    },
    sideEffect: "none",
    needsConnection: false,
    label: (i: { language?: string }) => `Ran ${i.language === "javascript" ? "JavaScript" : "Python"} in the sandbox`,
    execute: async (input: { language?: SandboxLanguage; code: string; inputs?: unknown; file_ids?: string[] }, ctx): Promise<ToolResult> => {
      const [run] = await db.select().from(runs).where(eq(runs.id, ctx.runId));
      if (!run) throw new Error("Run not found");
      const res = await runCodeForRun({ run, language: input.language ?? "python", code: input.code, inputs: input.inputs, fileIds: input.file_ids, resolve });
      const logs = res.logs.length > 4000 ? `…${res.logs.slice(-4000)}` : res.logs;
      if (!res.ok) throw new Error(`${res.error ?? "Code failed"}${logs ? `\n--- output ---\n${logs}` : ""}`.slice(0, 6000));
      return {
        output: { result: res.result, stdout: logs, files: res.artifactIds.length, duration_ms: res.durationMs },
        summary: `${res.artifactIds.length ? `${res.artifactIds.length} file${res.artifactIds.length > 1 ? "s" : ""} · ` : ""}${(res.durationMs / 1000).toFixed(1)}s`,
        credits: sandboxCredits(res.durationMs),
        artifactIds: res.artifactIds,
      };
    },
  };
}
