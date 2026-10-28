/**
 * Workflow expressions: a small, safe language for conditions (`amount > 5000 and intent = refund`)
 * and data mapping (`{{ steps.a1.order_id }}`, `{{ sum(steps.m1.rows, "spend") }}`). No access to
 * globals, prototypes or I/O — only the scope object and the whitelisted functions below.
 *
 * Grammar (lowest → highest precedence):
 *   ternary   := or ("?" ternary ":" ternary)?
 *   or        := and (("or" | "||") and)*
 *   and       := not (("and" | "&&") not)*
 *   not       := ("not" | "!") not | compare
 *   compare   := additive (op additive)?   op: = == != ≠ < <= ≤ > >= ≥ in "not in" contains startswith endswith matches
 *   additive  := mult (("+" | "-") mult)*         also "??" (default)
 *   mult      := unary (("*" | "/" | "%") unary)*
 *   unary     := "-" unary | postfix
 *   postfix   := primary ("." ident | "[" expr "]" | "(" args ")")*
 *   primary   := number | number "%" | string | ident | "[" list "]" | "(" expr ")"
 * Bare identifiers that resolve to nothing compare as their own name, so `intent = order_status` works.
 */

export class ExprError extends Error {}

type Node =
  | { t: "num"; v: number; pct?: boolean }
  | { t: "str"; v: string }
  | { t: "lit"; v: unknown }
  | { t: "id"; name: string }
  | { t: "arr"; items: Node[] }
  | { t: "member"; obj: Node; key: Node; computed: boolean }
  | { t: "call"; fn: Node; args: Node[] }
  | { t: "un"; op: string; arg: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "tern"; c: Node; a: Node; b: Node };

interface Tok {
  k: "num" | "str" | "id" | "op" | "eof";
  v: string;
  pos: number;
}

const OPS = ["not in", "??", "==", "!=", "<=", ">=", "&&", "||", "≠", "≤", "≥", "=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", "[", "]", ",", ".", "?", ":"];
const WORD_OPS = new Set(["and", "or", "not", "in", "contains", "startswith", "endswith", "matches"]);

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      // 1,20,000 / 1,200,000 style separators only when followed by digit groups, so f(1, 2) still parses.
      const m = /^(\d{1,3}(?:,\d{2,3})+(?=[^\d,]|$)(?:\.\d+)?|\d[\d_]*(?:\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: m[0].replace(/[_,]/g, ""), pos: i });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"' || c === "“" || c === "‘") {
      const close = c === "“" ? "”" : c === "‘" ? "’" : c;
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== close) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new ExprError(`Unterminated string at ${i}`);
      out.push({ k: "str", v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[\p{L}_$]/u.test(c)) {
      const m = /^[\p{L}\p{N}_$]+/u.exec(src.slice(i))!;
      const w = m[0];
      if (w.toLowerCase() === "not" && /^\s+in\b/i.test(src.slice(i + w.length))) {
        const m2 = /^not\s+in/i.exec(src.slice(i))!;
        out.push({ k: "op", v: "not in", pos: i });
        i += m2[0].length;
        continue;
      }
      out.push({ k: WORD_OPS.has(w.toLowerCase()) ? "op" : "id", v: WORD_OPS.has(w.toLowerCase()) ? w.toLowerCase() : w, pos: i });
      i += w.length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Unexpected "${c}" at ${i}`);
    out.push({ k: "op", v: op, pos: i });
    i += op.length;
  }
  out.push({ k: "eof", v: "", pos: src.length });
  return out;
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}
  private peek() {
    return this.toks[this.i];
  }
  private next() {
    return this.toks[this.i++];
  }
  private is(v: string) {
    const t = this.peek();
    return t.k === "op" && t.v === v;
  }
  private eat(v: string) {
    if (!this.is(v)) throw new ExprError(`Expected "${v}" at ${this.peek().pos}`);
    this.next();
  }
  parse(): Node {
    const n = this.ternary();
    if (this.peek().k !== "eof") throw new ExprError(`Unexpected "${this.peek().v}" at ${this.peek().pos}`);
    return n;
  }
  private ternary(): Node {
    const c = this.or();
    if (this.is("?")) {
      this.next();
      const a = this.ternary();
      this.eat(":");
      const b = this.ternary();
      return { t: "tern", c, a, b };
    }
    return c;
  }
  private or(): Node {
    let l = this.and();
    while (this.is("or") || this.is("||")) {
      this.next();
      l = { t: "bin", op: "or", l, r: this.and() };
    }
    return l;
  }
  private and(): Node {
    let l = this.not();
    while (this.is("and") || this.is("&&")) {
      this.next();
      l = { t: "bin", op: "and", l, r: this.not() };
    }
    return l;
  }
  private not(): Node {
    if (this.is("not") || this.is("!")) {
      this.next();
      return { t: "un", op: "not", arg: this.not() };
    }
    return this.compare();
  }
  private compare(): Node {
    const l = this.additive();
    const t = this.peek();
    const map: Record<string, string> = { "=": "==", "==": "==", "!=": "!=", "≠": "!=", "<": "<", "<=": "<=", "≤": "<=", ">": ">", ">=": ">=", "≥": ">=", in: "in", "not in": "not in", contains: "contains", startswith: "startswith", endswith: "endswith", matches: "matches" };
    if (t.k === "op" && map[t.v]) {
      this.next();
      return { t: "bin", op: map[t.v], l, r: this.additive() };
    }
    return l;
  }
  private additive(): Node {
    let l = this.mult();
    while (this.is("+") || this.is("-") || this.is("??")) {
      const op = this.next().v;
      l = { t: "bin", op, l, r: this.mult() };
    }
    return l;
  }
  private mult(): Node {
    let l = this.unary();
    while (this.is("*") || this.is("/") || (this.is("%") && !this.pctFollows())) {
      const op = this.next().v;
      l = { t: "bin", op, l, r: this.unary() };
    }
    return l;
  }
  private pctFollows() {
    return false;
  }
  private unary(): Node {
    if (this.is("-")) {
      this.next();
      return { t: "un", op: "-", arg: this.unary() };
    }
    return this.postfix();
  }
  private postfix(): Node {
    let n = this.primary();
    for (;;) {
      if (this.is(".")) {
        this.next();
        const t = this.next();
        if (t.k !== "id" && t.k !== "op" && t.k !== "num") throw new ExprError(`Expected a field name at ${t.pos}`);
        n = { t: "member", obj: n, key: { t: "str", v: t.v }, computed: false };
      } else if (this.is("[")) {
        this.next();
        const key = this.ternary();
        this.eat("]");
        n = { t: "member", obj: n, key, computed: true };
      } else if (this.is("(")) {
        this.next();
        const args: Node[] = [];
        if (!this.is(")")) {
          do args.push(this.ternary());
          while (this.is(",") && this.next());
        }
        this.eat(")");
        n = { t: "call", fn: n, args };
      } else return n;
    }
  }
  private primary(): Node {
    const t = this.next();
    if (t.k === "num") {
      // 95% → 0.95 (compared against 0-1 or 0-100 scales, see compare())
      if (this.is("%")) {
        const after = this.toks[this.i + 1];
        if (!after || after.k === "eof" || (after.k === "op" && [")", "]", ",", "and", "or", "&&", "||", "?", ":"].includes(after.v))) {
          this.next();
          return { t: "num", v: Number(t.v) / 100, pct: true };
        }
      }
      return { t: "num", v: Number(t.v) };
    }
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "id") {
      const low = t.v.toLowerCase();
      if (low === "true" || low === "yes" || low === "always" || low === "else" || low === "otherwise" || low === "default") return { t: "lit", v: true };
      if (low === "false" || low === "no" || low === "never") return { t: "lit", v: false };
      if (low === "null" || low === "none") return { t: "lit", v: null };
      return { t: "id", name: t.v };
    }
    if (t.k === "op" && t.v === "(") {
      const n = this.ternary();
      this.eat(")");
      return n;
    }
    if (t.k === "op" && t.v === "[") {
      const items: Node[] = [];
      if (!this.is("]")) {
        do items.push(this.ternary());
        while (this.is(",") && this.next());
      }
      this.eat("]");
      return { t: "arr", items };
    }
    throw new ExprError(t.k === "eof" ? "Unexpected end of expression" : `Unexpected "${t.v}" at ${t.pos}`);
  }
}

const cache = new Map<string, Node>();
export function parseExpr(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    n = new Parser(lex(src)).parse();
    if (cache.size > 2000) cache.clear();
    cache.set(src, n);
  }
  return n;
}

// ─── Evaluation ────────────────────────────────────────────────────────────────

export type Scope = Record<string, unknown>;
const UNSAFE = new Set(["__proto__", "prototype", "constructor"]);

function get(obj: unknown, key: unknown): unknown {
  if (obj == null) return undefined;
  const k = String(key);
  if (UNSAFE.has(k)) return undefined;
  if (Array.isArray(obj)) {
    if (k === "length") return obj.length;
    if (/^-?\d+$/.test(k)) {
      const i = Number(k);
      return obj[i < 0 ? obj.length + i : i];
    }
    // list.field → pluck
    return obj.map((x) => get(x, k));
  }
  if (typeof obj === "string" && k === "length") return obj.length;
  if (typeof obj !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(obj, k) ? (obj as Record<string, unknown>)[k] : undefined;
}

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[₹$€£,\s]/g, "").replace(/%$/, ""));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
};
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : typeof v === "object" ? Object.values(v as object) : [v]);
const nums = (v: unknown, field?: unknown) => listOf(v).map((x) => num(field != null ? get(x, field) : x)).filter((n) => !Number.isNaN(n));
export const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : !!v);

const FUNCS: Record<string, (...a: unknown[]) => unknown> = {
  len: (v) => (typeof v === "string" || Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0),
  count: (v) => listOf(v).length,
  lower: (v) => String(v ?? "").toLowerCase(),
  upper: (v) => String(v ?? "").toUpperCase(),
  trim: (v) => String(v ?? "").trim(),
  string: (v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "")),
  number: (v) => num(v),
  int: (v) => Math.trunc(num(v)),
  bool: (v) => truthy(v),
  json: (v) => JSON.stringify(v, null, 2),
  parse_json: (v) => {
    try {
      return JSON.parse(String(v));
    } catch {
      return null;
    }
  },
  join: (v, sep) => listOf(v).map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(sep == null ? ", " : String(sep)),
  split: (v, sep) => String(v ?? "").split(sep == null ? "," : String(sep)).map((s) => s.trim()).filter(Boolean),
  replace: (v, a, b) => String(v ?? "").split(String(a)).join(String(b ?? "")),
  slice: (v, a, b) => (Array.isArray(v) ? v.slice(num(a), b == null ? undefined : num(b)) : String(v ?? "").slice(num(a), b == null ? undefined : num(b))),
  truncate: (v, n) => {
    const s = String(v ?? "");
    const m = num(n) || 200;
    return s.length > m ? `${s.slice(0, m - 1)}…` : s;
  },
  sum: (v, f) => nums(v, f).reduce((a, b) => a + b, 0),
  avg: (v, f) => {
    const a = nums(v, f);
    return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  },
  min: (...a) => Math.min(...(a.length === 1 ? nums(a[0]) : a.map(num))),
  max: (...a) => Math.max(...(a.length === 1 ? nums(a[0]) : a.map(num))),
  round: (v, d) => {
    const p = 10 ** (num(d) || 0);
    return Math.round(num(v) * p) / p;
  },
  abs: (v) => Math.abs(num(v)),
  pct: (a, b) => (num(b) ? Math.round((num(a) / num(b)) * 1000) / 10 : 0),
  first: (v) => listOf(v)[0],
  last: (v) => listOf(v).at(-1),
  keys: (v) => (v && typeof v === "object" ? Object.keys(v) : []),
  values: (v) => (v && typeof v === "object" ? Object.values(v) : []),
  pluck: (v, f) => listOf(v).map((x) => get(x, f)),
  unique: (v) => [...new Set(listOf(v).map((x) => (typeof x === "object" ? JSON.stringify(x) : x)))],
  sort_by: (v, f, dir) => [...listOf(v)].sort((a, b) => {
    const x = get(a, f);
    const y = get(b, f);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return String(dir).toLowerCase() === "desc" ? -c : c;
  }),
  where: (v, f, val) => listOf(v).filter((x) => looseEq(get(x, f), val)),
  top: (v, n) => listOf(v).slice(0, num(n) || 5),
  contains: (a, b) => contains(a, b),
  startswith: (a, b) => String(a ?? "").toLowerCase().startsWith(String(b ?? "").toLowerCase()),
  endswith: (a, b) => String(a ?? "").toLowerCase().endsWith(String(b ?? "").toLowerCase()),
  default: (a, b) => (a == null || a === "" ? b : a),
  coalesce: (...a) => a.find((x) => x != null && x !== ""),
  if: (c, a, b) => (truthy(c) ? a : b),
  now: () => new Date().toISOString(),
  today: () => new Date().toISOString().slice(0, 10),
  date: (v) => {
    const d = v == null ? new Date() : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  },
  days_ago: (n) => new Date(Date.now() - num(n) * 86400_000).toISOString().slice(0, 10),
  days_between: (a, b) => Math.round((new Date(String(b ?? new Date().toISOString())).getTime() - new Date(String(a)).getTime()) / 86400_000),
  inr: (v) => `₹${num(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`,
  format_number: (v, d) => num(v).toLocaleString("en-IN", { maximumFractionDigits: num(d) || 0 }),
  email_domain: (v) => String(v ?? "").split("@")[1]?.toLowerCase() ?? "",
};

export const FUNCTION_NAMES = Object.keys(FUNCS);

function looseEq(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == b;
  if (typeof a === "number" || typeof b === "number") {
    const x = num(a);
    const y = num(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x === y;
  }
  if (typeof a === "boolean" || typeof b === "boolean") return truthy(a) === truthy(b);
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function contains(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return a.some((x) => looseEq(x, b));
  if (a && typeof a === "object") return Object.prototype.hasOwnProperty.call(a, String(b));
  return String(a ?? "").toLowerCase().includes(String(b ?? "").toLowerCase());
}

interface Ctx {
  scope: Scope;
  fallback?: Scope;
}

function lookup(name: string, ctx: Ctx): unknown {
  if (UNSAFE.has(name)) return undefined;
  if (Object.prototype.hasOwnProperty.call(ctx.scope, name)) return ctx.scope[name];
  if (ctx.fallback && Object.prototype.hasOwnProperty.call(ctx.fallback, name)) return ctx.fallback[name];
  return undefined;
}

function value(n: Node, ctx: Ctx): unknown {
  switch (n.t) {
    case "num":
      return n.v;
    case "str":
    case "lit":
      return n.v;
    case "id":
      return lookup(n.name, ctx);
    case "arr":
      return n.items.map((x) => value(x, ctx));
    case "member":
      return get(value(n.obj, ctx), n.computed ? value(n.key, ctx) : (n.key as { v: string }).v);
    case "call": {
      if (n.fn.t !== "id") throw new ExprError("Only built-in functions can be called");
      const f = FUNCS[n.fn.name.toLowerCase()];
      if (!f) throw new ExprError(`Unknown function ${n.fn.name}()`);
      return f(...n.args.map((a) => value(a, ctx)));
    }
    case "un":
      return n.op === "not" ? !truthy(value(n.arg, ctx)) : -num(value(n.arg, ctx));
    case "tern":
      return truthy(value(n.c, ctx)) ? value(n.a, ctx) : value(n.b, ctx);
    case "bin":
      return binary(n, ctx);
  }
}

/** Unresolved bare identifiers on either side of a comparison act as string literals. */
function operand(n: Node, ctx: Ctx): unknown {
  const v = value(n, ctx);
  return v === undefined && n.t === "id" ? n.name : v;
}

function binary(n: Extract<Node, { t: "bin" }>, ctx: Ctx): unknown {
  if (n.op === "and") return truthy(value(n.l, ctx)) && truthy(value(n.r, ctx));
  if (n.op === "or") return truthy(value(n.l, ctx)) || truthy(value(n.r, ctx));
  if (n.op === "??") {
    const l = value(n.l, ctx);
    return l == null || l === "" ? value(n.r, ctx) : l;
  }
  if (["==", "!=", "<", "<=", ">", ">=", "in", "not in", "contains", "startswith", "endswith", "matches"].includes(n.op)) {
    let l = operand(n.l, ctx);
    let r = operand(n.r, ctx);
    // "confidence ≥ 95%" works for 0.97 and for 97.
    if (n.r.t === "num" && n.r.pct && num(l) > 1) r = num(r) * 100;
    if (n.l.t === "num" && n.l.pct && num(r) > 1) l = num(l) * 100;
    switch (n.op) {
      case "==":
        return looseEq(l, r);
      case "!=":
        return !looseEq(l, r);
      case "in":
        return contains(r, l);
      case "not in":
        return !contains(r, l);
      case "contains":
        return contains(l, r);
      case "startswith":
        return FUNCS.startswith(l, r);
      case "endswith":
        return FUNCS.endswith(l, r);
      case "matches":
        try {
          return new RegExp(String(r), "i").test(String(l ?? ""));
        } catch {
          return false;
        }
    }
    const x = num(l);
    const y = num(r);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const c = String(l ?? "").localeCompare(String(r ?? ""));
      return n.op === "<" ? c < 0 : n.op === "<=" ? c <= 0 : n.op === ">" ? c > 0 : c >= 0;
    }
    return n.op === "<" ? x < y : n.op === "<=" ? x <= y : n.op === ">" ? x > y : x >= y;
  }
  const l = value(n.l, ctx);
  const r = value(n.r, ctx);
  if (n.op === "+") {
    if (typeof l === "number" && typeof r === "number") return l + r;
    if (Array.isArray(l)) return [...l, ...listOf(r)];
    const x = num(l);
    const y = num(r);
    return typeof l === "string" || typeof r === "string" || Number.isNaN(x) || Number.isNaN(y) ? `${l ?? ""}${r ?? ""}` : x + y;
  }
  const x = num(l);
  const y = num(r);
  switch (n.op) {
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? null : x / y;
    case "%":
      return y === 0 ? null : x % y;
  }
  throw new ExprError(`Unknown operator ${n.op}`);
}

export function evaluate(src: string, scope: Scope, fallback?: Scope): unknown {
  return value(parseExpr(src), { scope, fallback });
}

export function test(src: string, scope: Scope, fallback?: Scope): boolean {
  const s = src.trim().replace(/\?+$/, "").trim();
  if (!s) return true;
  return truthy(evaluate(s, scope, fallback));
}

/** Throws ExprError with a readable message when the expression doesn't parse. */
export function checkExpr(src: string) {
  parseExpr(src.trim().replace(/\?+$/, "").trim());
}

// ─── Templates ─────────────────────────────────────────────────────────────────

const WHOLE = /^\s*\{\{((?:(?!\}\}|\{\{)[\s\S])+)\}\}\s*$/;
const PART = /\{\{([\s\S]+?)\}\}/g;

const show = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Render `{{ expr }}` placeholders. A string that is exactly one placeholder keeps the value's type. */
export function render(tpl: unknown, scope: Scope, fallback?: Scope): unknown {
  if (typeof tpl === "string") {
    const whole = WHOLE.exec(tpl);
    if (whole) return evaluate(whole[1].trim(), scope, fallback);
    if (!tpl.includes("{{")) return tpl;
    return tpl.replace(PART, (_m, e: string) => show(evaluate(e.trim(), scope, fallback)));
  }
  if (Array.isArray(tpl)) return tpl.map((x) => render(x, scope, fallback));
  if (tpl && typeof tpl === "object") return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, render(v, scope, fallback)]));
  return tpl;
}

/** Every `{{ … }}` expression in a template (for validation). */
export function templateExprs(tpl: unknown): string[] {
  if (typeof tpl === "string") return [...tpl.matchAll(PART)].map((m) => m[1].trim());
  if (Array.isArray(tpl)) return tpl.flatMap(templateExprs);
  if (tpl && typeof tpl === "object") return Object.values(tpl).flatMap(templateExprs);
  return [];
}
