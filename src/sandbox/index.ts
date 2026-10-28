import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, sandboxProvider } from "../config.js";

/**
 * Code sandbox (architecture §4.6). Each run gets a fresh interpreter in an isolated environment
 * with no network; the only way out is a line-delimited JSON protocol on stdin/stdout through
 * which code calls workspace tools (policy-checked by the host) and returns its result and files.
 */

export type SandboxLanguage = "python" | "javascript";

export interface SandboxFile {
  name: string;
  data: Buffer;
}

export interface SandboxRequest {
  language: SandboxLanguage;
  code: string;
  inputs?: unknown;
  files?: SandboxFile[];
  timeoutMs?: number;
  /** Called for every `tools.<app>.<action>(...)` the code makes. Throw to fail that call. */
  onToolCall?: (action: string, input: Record<string, unknown>) => Promise<unknown>;
}

export interface SandboxResult {
  ok: boolean;
  result: unknown;
  error: string | null;
  logs: string;
  files: SandboxFile[];
  durationMs: number;
  toolCalls: number;
  provider: string;
}

const RUNNERS = {
  python: readFileSync(new URL("./runtime/runner.py", import.meta.url), "utf8"),
  javascript: readFileSync(new URL("./runtime/runner.mjs", import.meta.url), "utf8"),
};
const MAX_LOG_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 40 * 1024 * 1024;
const MAX_TOOL_CALLS = 200;

export class SandboxUnavailableError extends Error {}

// ─── Concurrency gate ──────────────────────────────────────────────────────────

let active = 0;
const queue: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= config.SANDBOX_MAX_CONCURRENCY) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

// ─── Providers ─────────────────────────────────────────────────────────────────

interface Launch {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  kill?: () => void;
  cleanup?: () => Promise<void>;
}

function interpreter(language: SandboxLanguage, python: string): string[] {
  return language === "python" ? [python, "-u", "-I", "-c", RUNNERS.python] : ["node", `--max-old-space-size=${Math.max(64, Math.floor(config.SANDBOX_MEMORY_MB * 0.75))}`, "--input-type=module", "-e", RUNNERS.javascript];
}

function dockerLaunch(language: SandboxLanguage): Launch {
  const name = `anvita-sbx-${randomBytes(6).toString("hex")}`;
  const mem = `${config.SANDBOX_MEMORY_MB}m`;
  return {
    cmd: config.SANDBOX_DOCKER_BIN,
    args: [
      "run", "--rm", "-i", "--name", name,
      "--network", "none",
      "--memory", mem, "--memory-swap", mem,
      "--cpus", String(config.SANDBOX_CPUS),
      "--pids-limit", "256",
      "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
      "--tmpfs", "/work:rw,nosuid,nodev,size=512m,uid=10001,gid=10001",
      "--user", "10001:10001",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--ulimit", "nofile=256:256",
      "-e", "ANVITA_WORK=/work", "-e", "HOME=/tmp", "-e", "MPLBACKEND=Agg", "-e", "MPLCONFIGDIR=/tmp",
      config.SANDBOX_IMAGE,
      ...interpreter(language, "python"),
    ],
    kill: () => void spawn(config.SANDBOX_DOCKER_BIN, ["kill", name], { stdio: "ignore" }).on("error", () => {}),
  };
}

let unshareOk: boolean | null = null;
function canUnshare() {
  unshareOk ??= spawnSync("unshare", ["--user", "--map-root-user", "--net", "true"], { stdio: "ignore" }).status === 0;
  return unshareOk;
}

async function processLaunch(language: SandboxLanguage): Promise<Launch> {
  const work = await mkdtemp(join(tmpdir(), "anvita-sbx-"));
  const cmd = interpreter(language, "python3");
  // Separate user + network namespace (no network at all) when the kernel allows it, plus rlimits.
  const limits = ["prlimit", `--cpu=${Math.ceil(config.SANDBOX_TIMEOUT_MS / 1000) + 5}`, `--fsize=${512 * 1024 * 1024}`, "--nofile=256", ...(language === "python" ? [`--as=${config.SANDBOX_MEMORY_MB * 2 * 1024 * 1024}`] : []), "--"];
  const wrapped = [...(canUnshare() ? ["unshare", "--user", "--map-root-user", "--net", "--"] : []), ...limits, ...cmd];
  return {
    cmd: wrapped[0],
    args: wrapped.slice(1),
    cwd: work,
    env: { PATH: process.env.PATH, HOME: work, LANG: "C.UTF-8", ANVITA_WORK: work, MPLBACKEND: "Agg", MPLCONFIGDIR: work, PYTHONDONTWRITEBYTECODE: "1" },
    cleanup: () => rm(work, { recursive: true, force: true }),
  };
}

// ─── Run ───────────────────────────────────────────────────────────────────────

export function sandboxAvailable() {
  return sandboxProvider() !== "disabled";
}

export async function runInSandbox(req: SandboxRequest): Promise<SandboxResult> {
  const provider = sandboxProvider();
  if (provider === "disabled") throw new SandboxUnavailableError("Code execution is disabled on this deployment (SANDBOX_PROVIDER=disabled)");
  return slot(() => execute(req, provider));
}

async function execute(req: SandboxRequest, provider: "docker" | "process"): Promise<SandboxResult> {
  const launch = provider === "docker" ? dockerLaunch(req.language) : await processLaunch(req.language);
  const started = Date.now();
  const timeoutMs = Math.min(req.timeoutMs ?? config.SANDBOX_TIMEOUT_MS, config.SANDBOX_TIMEOUT_MS);
  let logs = "";
  let logsTruncated = false;
  let toolCalls = 0;

  try {
    return await new Promise<SandboxResult>((resolve) => {
      const child = spawn(launch.cmd, launch.args, { cwd: launch.cwd, env: launch.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
      let settled = false;
      let pending = "";
      const finish = (r: Omit<SandboxResult, "logs" | "durationMs" | "toolCalls" | "provider">) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null) {
          launch.kill?.();
          child.kill("SIGKILL");
        }
        resolve({ ...r, logs: logsTruncated ? `${logs}\n… [logs truncated]` : logs, durationMs: Date.now() - started, toolCalls, provider });
      };
      const fail = (error: string) => finish({ ok: false, result: null, error, files: [] });
      const timer = setTimeout(() => fail(`Timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);

      const write = (msg: unknown) => {
        if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(msg)}\n`);
      };

      child.on("error", (e) => fail(provider === "docker" ? `Couldn't start the sandbox container: ${e.message}. Is Docker available and ${config.SANDBOX_IMAGE} pulled?` : `Couldn't start the interpreter: ${e.message}`));
      child.stdin.on("error", () => {});
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => {
        if (logs.length < MAX_LOG_BYTES) logs += d.slice(0, MAX_LOG_BYTES - logs.length);
        else logsTruncated = true;
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        pending += d;
        if (pending.length > MAX_LINE_BYTES) return fail("Sandbox output too large");
        let i: number;
        while ((i = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, i);
          pending = pending.slice(i + 1);
          let msg: { t?: string; id?: number; action?: string; input?: Record<string, unknown>; ok?: boolean; result?: unknown; error?: string; files?: { name: string; b64: string }[] };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.t === "tool") {
            const id = msg.id;
            if (++toolCalls > MAX_TOOL_CALLS) {
              write({ id, ok: false, error: `Too many tool calls (limit ${MAX_TOOL_CALLS})` });
              continue;
            }
            if (!req.onToolCall) {
              write({ id, ok: false, error: "Tools aren't available in this sandbox" });
              continue;
            }
            req
              .onToolCall(String(msg.action ?? ""), msg.input ?? {})
              .then((output) => write({ id, ok: true, output: output ?? null }))
              .catch((e: unknown) => write({ id, ok: false, error: e instanceof Error ? e.message : String(e) }));
          } else if (msg.t === "done") {
            finish({ ok: !!msg.ok, result: msg.result ?? null, error: msg.ok ? null : msg.error ?? "Failed", files: (msg.files ?? []).map((f) => ({ name: f.name, data: Buffer.from(f.b64, "base64") })) });
          }
        }
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        const tail = logs.trim().split("\n").slice(-6).join("\n");
        fail(code === 137 || signal === "SIGKILL" ? `The sandbox was killed (out of memory or CPU time)${tail ? `\n${tail}` : ""}` : `The sandbox exited unexpectedly (code ${code ?? signal})${tail ? `\n${tail}` : ""}`);
      });

      write({ code: req.code, inputs: req.inputs ?? {}, files: (req.files ?? []).map((f) => ({ name: f.name, b64: f.data.toString("base64") })), limits: { maxFilesBytes: 25 * 1024 * 1024 } });
    });
  } finally {
    await launch.cleanup?.();
  }
}

// ─── Helpers for callers ───────────────────────────────────────────────────────

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  xml: "application/xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

export function describeFile(name: string): { mime: string; kind: "pdf" | "sheet" | "chart" | "dashboard" | "doc" | "app"; text: boolean } {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mime = EXT_MIME[ext] ?? "application/octet-stream";
  const kind = ext === "pdf" ? "pdf" : ["csv", "tsv", "xlsx", "xls"].includes(ext) ? "sheet" : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) ? "chart" : ext === "html" ? "dashboard" : "doc";
  const text = /^text\//.test(mime) || ["application/json", "application/xml", "image/svg+xml"].includes(mime);
  return { mime, kind, text };
}
