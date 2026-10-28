// Anvita sandbox runner (JavaScript). Same stdin/stdout protocol as runner.py: the first stdin
// line is {code, inputs, files, limits}; tool calls and the final result are JSON lines on stdout.
// console.* goes to stderr, which the host keeps as logs.
import fs from "node:fs";
import path from "node:path";

const out = process.stdout;
const send = (msg) => out.write(JSON.stringify(msg) + "\n");
for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => process.stderr.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");

const WORK = process.env.ANVITA_WORK || "/work";
const OUT = path.join(WORK, "out");
const IN = path.join(WORK, "in");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(IN, { recursive: true });
process.chdir(WORK);

let buf = "";
const lines = [];
const waiters = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const w = waiters.shift();
    if (w) w(line);
    else lines.push(line);
  }
});
process.stdin.on("end", () => {
  while (waiters.length) waiters.shift()(null);
});
const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiters.push(r)));

class ToolError extends Error {}
let seq = 0;
let chain = Promise.resolve();
/** Tool calls are serialized: the protocol is strictly request → response. */
function call(action, input) {
  const run = chain.then(async () => {
    const id = ++seq;
    send({ t: "tool", id, action, input: input ?? {} });
    const line = await nextLine();
    if (line == null) throw new ToolError("The sandbox host closed the connection");
    const msg = JSON.parse(line);
    if (!msg.ok) throw new ToolError(msg.error || "Tool call failed");
    return msg.output;
  });
  chain = run.catch(() => {});
  return run;
}

function toolPath(parts) {
  return new Proxy(function () {}, {
    get: (_t, k) => (typeof k === "symbol" ? undefined : parts.length === 0 && k === "call" ? (action, input) => call(action, input) : toolPath([...parts, k])),
    apply: (_t, _this, args) => call(parts.join("."), args[0] ?? {}),
  });
}

const safe = (n) => path.basename(String(n)).replace(/[\\/]/g, "_") || "file";
const csvCell = (v) => {
  const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const files = {
  outDir: OUT,
  inDir: IN,
  path: (name) => path.join(OUT, safe(name)),
  save: (name, data) => (fs.writeFileSync(path.join(OUT, safe(name)), data), path.join(OUT, safe(name))),
  text: (name, text) => files.save(name, String(text)),
  json: (name, data) => files.save(name, JSON.stringify(data, null, 2)),
  csv: (name, rows) => {
    const list = Array.from(rows ?? []);
    const header = list.length && !Array.isArray(list[0]) ? Object.keys(list[0]) : null;
    const body = list.map((r) => (header ? header.map((h) => csvCell(r[h])) : r.map(csvCell)).join(","));
    return files.save(name, [header?.map(csvCell).join(","), ...body].filter((x) => x != null).join("\n") + "\n");
  },
  read: (name, encoding = "utf8") => fs.readFileSync(path.join(IN, safe(name)), encoding),
  list: () => fs.readdirSync(IN).sort(),
};

function collect(limit) {
  let total = 0;
  const res = [];
  for (const name of fs.readdirSync(OUT).sort()) {
    const p = path.join(OUT, name);
    if (!fs.statSync(p).isFile()) continue;
    total += fs.statSync(p).size;
    if (total > limit) {
      console.error(`[anvita] skipped ${name}: output files exceed limit`);
      continue;
    }
    res.push({ name, b64: fs.readFileSync(p).toString("base64") });
  }
  return res;
}

const boot = JSON.parse(await nextLine());
for (const f of boot.files ?? []) fs.writeFileSync(path.join(IN, safe(f.name)), Buffer.from(f.b64, "base64"));
const limit = boot.limits?.maxFilesBytes ?? 25 * 1024 * 1024;
const inputs = boot.inputs ?? {};
const tools = toolPath([]);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
try {
  const fn = new AsyncFunction("inputs", "steps", "tools", "files", "ToolError", boot.code);
  const result = await fn(inputs, inputs.steps ?? {}, tools, files, ToolError);
  send({ t: "done", ok: true, result: result ?? null, files: collect(limit) });
} catch (e) {
  const m = /<anonymous>:(\d+):\d+/.exec(String(e?.stack ?? ""));
  send({ t: "done", ok: false, error: `${e?.name ?? "Error"}: ${e?.message ?? e}${m ? ` (line ${Number(m[1]) - 2})` : ""}`, files: collect(limit) });
}
process.exit(0);
