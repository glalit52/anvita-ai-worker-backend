import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { policies } from "../db/schema.js";
import type { SideEffect } from "./tools/types.js";

/**
 * Policy engine — "policy before side effects" (architecture §4.11).
 *
 * A policy matches an action by glob (`gmail.send`, `*.delete`, `hubspot.*.update`) and an
 * optional condition over facts derived from the tool call:
 *
 *   always | never
 *   amount > 5000
 *   external_recipients > 0 and actor == worker
 *   recipients >= 500 or app in [razorpay, stripe]
 *   not (risk == low)
 *
 * When several enabled policies match, the most restrictive effect wins (deny > approve > allow).
 * With no match, the default depends on the tool's side effect: reads/writes are allowed,
 * external and destructive actions need approval.
 */

export type Effect = "allow" | "approve" | "deny";
export type Facts = Record<string, string | number | boolean | string[] | undefined>;

export interface Decision {
  effect: Effect;
  policyId?: string;
  policyName?: string;
  approvers?: string | null;
  reason: string;
}

// ─── Condition language ────────────────────────────────────────────────────────

type Tok = { t: "num"; v: number } | { t: "str"; v: string } | { t: "word"; v: string } | { t: "op"; v: string } | { t: "punc"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|"([^"]*)"|'([^']*)'|(>=|<=|==|!=|>|<|=)|([()[\],])|([@\w.*-]+))/y;
  let m: RegExpExecArray | null;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    m = re.exec(src);
    if (!m || m[0].length === 0) {
      if (/^\s*$/.test(src.slice(i))) break;
      throw new Error(`Unexpected input at "${src.slice(i, i + 12)}"`);
    }
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ t: "str", v: (m[2] ?? m[3])! });
    else if (m[4]) out.push({ t: "op", v: m[4] === "=" ? "==" : m[4] });
    else if (m[5]) out.push({ t: "punc", v: m[5] });
    else if (m[6]) out.push({ t: "word", v: m[6] });
  }
  return out;
}

type Value = string | number | boolean | string[] | (string | number)[] | undefined;

function compare(op: string, left: Value, right: Value): boolean {
  const num = (v: Value) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : NaN);
  switch (op) {
    case ">": return num(left) > num(right);
    case ">=": return num(left) >= num(right);
    case "<": return num(left) < num(right);
    case "<=": return num(left) <= num(right);
    case "==": return String(left).toLowerCase() === String(right).toLowerCase();
    case "!=": return String(left).toLowerCase() !== String(right).toLowerCase();
    case "in": return Array.isArray(right) && right.map((x) => String(x).toLowerCase()).includes(String(left).toLowerCase());
    case "contains": return Array.isArray(left) ? left.map((x) => String(x).toLowerCase()).includes(String(right).toLowerCase()) : String(left ?? "").toLowerCase().includes(String(right).toLowerCase());
    default: throw new Error(`Unknown operator ${op}`);
  }
}

export function evaluateCondition(src: string, facts: Facts): boolean {
  const text = src.trim();
  if (!text || /^always$/i.test(text)) return true;
  const toks = tokenize(text);
  let pos = 0;
  const peek = () => toks[pos];
  const isWord = (w: string) => peek()?.t === "word" && (peek() as { v: string }).v.toLowerCase() === w;
  const next = () => toks[pos++];

  const value = (): Value => {
    const tok = next();
    if (!tok) throw new Error("Expected a value");
    if (tok.t === "num" || tok.t === "str") return tok.v;
    if (tok.t === "punc" && tok.v === "[") {
      const items: (string | number)[] = [];
      while (!(peek()?.t === "punc" && (peek() as { v: string }).v === "]")) {
        const v = value();
        items.push(v as string | number);
        if (peek()?.t === "punc" && (peek() as { v: string }).v === ",") next();
      }
      next();
      return items;
    }
    if (tok.t === "word") {
      if (tok.v === "true") return true;
      if (tok.v === "false") return false;
      return tok.v;
    }
    throw new Error(`Unexpected ${tok.v}`);
  };

  const atom = (): boolean => {
    const tok = peek();
    if (!tok) throw new Error("Unexpected end of condition");
    if (tok.t === "punc" && tok.v === "(") {
      next();
      const v = or();
      if (!(peek()?.t === "punc" && (peek() as { v: string }).v === ")")) throw new Error("Missing )");
      next();
      return v;
    }
    if (isWord("always")) return next(), true;
    if (isWord("never")) return next(), false;
    if (tok.t !== "word") throw new Error(`Expected a fact name, got ${String(tok.v)}`);
    next();
    const left = facts[tok.v.toLowerCase()] as Value;
    let op: string | null = null;
    let negate = false;
    if (peek()?.t === "op") op = (next() as { v: string }).v;
    else if (isWord("is")) {
      next();
      if (isWord("not")) next(), (negate = true);
      op = "==";
    } else if (isWord("not")) {
      next();
      if (!isWord("in")) throw new Error("Expected 'in' after 'not'");
      next();
      op = "in";
      negate = true;
    } else if (isWord("in") || isWord("contains")) op = (next() as { v: string }).v.toLowerCase();
    if (!op) return Boolean(Array.isArray(left) ? left.length : left);
    const res = compare(op, left, value());
    return negate ? !res : res;
  };

  const not = (): boolean => (isWord("not") ? (next(), !not()) : atom());
  const and = (): boolean => {
    let v = not();
    while (isWord("and")) next(), (v = not() && v);
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (isWord("or")) next(), (v = and() || v);
    return v;
  };

  const result = or();
  if (pos < toks.length) throw new Error(`Unexpected "${String(toks[pos].v)}"`);
  return result;
}

/** Validate a condition at write time so broken policies can't be saved. */
export function validateCondition(src: string): string | null {
  try {
    evaluateCondition(src, {});
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// ─── Matching ──────────────────────────────────────────────────────────────────

function globToRegex(glob: string): RegExp {
  const escaped = glob.trim().toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^]*");
  return new RegExp(`^${escaped}$`);
}

export function matchesAction(appliesTo: string, action: string): boolean {
  return appliesTo
    .split(/[,·]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .some((g) => g === "*" || globToRegex(g).test(action.toLowerCase()));
}

const RANK: Record<Effect, number> = { allow: 0, approve: 1, deny: 2 };

export function defaultEffect(sideEffect: SideEffect): Effect {
  return sideEffect === "external" || sideEffect === "destructive" ? "approve" : "allow";
}

export async function evaluatePolicies(workspaceId: string, action: string, sideEffect: SideEffect, facts: Facts): Promise<Decision> {
  const rows = await db.select().from(policies).where(and(eq(policies.workspaceId, workspaceId), eq(policies.enabled, true))).orderBy(asc(policies.priority), asc(policies.createdAt));
  let best: Decision | null = null;
  const hits: string[] = [];
  for (const p of rows) {
    if (!matchesAction(p.appliesTo, action)) continue;
    let ok = false;
    try {
      ok = evaluateCondition(p.condition, facts);
    } catch {
      ok = false; // invalid conditions never match (they're rejected at write time anyway)
    }
    if (!ok) continue;
    hits.push(p.id);
    if (!best || RANK[p.effect] > RANK[best.effect]) best = { effect: p.effect, policyId: p.id, policyName: p.name, approvers: p.approvers, reason: `Policy “${p.name}”` };
  }
  if (hits.length) await db.update(policies).set({ hits30d: sql`${policies.hits30d} + 1` }).where(sql`${policies.id} in ${hits}`);
  if (best) return best;
  const effect = defaultEffect(sideEffect);
  return { effect, reason: effect === "approve" ? "External actions need approval by default" : "Allowed by default" };
}
