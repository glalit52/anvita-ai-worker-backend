import { createHmac, randomBytes } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces } from "../db/schema.js";

/**
 * Workspace security policies (Settings → Security), enforced by the API:
 *  - security.mfa           members who signed in with a password must also pass two-step verification
 *  - security.ipAllowlist   + security.ipRanges (comma/newline separated IPs or CIDRs)
 *  - security.sessionHours  maximum age of a sign-in before people must sign in again
 *  - security.retentionDays conversation content older than this is deleted (audit is kept)
 *  - security.piiRedaction  mask Aadhaar, PAN, phone, card and bank numbers in run logs and audit
 *  - security.domainCapture new sign-ups from the workspace's domains join it as members
 */

export interface SecurityPolicy {
  mfa: boolean;
  ipAllowlist: string[] | null;
  sessionHours: number | null;
  retentionDays: number | null;
  piiRedaction: boolean;
  domainCapture: boolean;
}

const cache = new Map<string, { at: number; policy: SecurityPolicy }>();

export function policyFrom(settings: Record<string, unknown>): SecurityPolicy {
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const ranges = String(settings["security.ipRanges"] ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    mfa: settings["security.mfa"] === true,
    ipAllowlist: settings["security.ipAllowlist"] === true && ranges.length ? ranges : null,
    sessionHours: num(settings["security.sessionHours"]),
    retentionDays: num(settings["security.retentionDays"]),
    piiRedaction: settings["security.piiRedaction"] === true,
    domainCapture: settings["security.domainCapture"] === true,
  };
}

/** Cached for a few seconds: checked on every request. */
export async function securityPolicy(workspaceId: string): Promise<SecurityPolicy> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < 5_000) return hit.policy;
  const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const policy = policyFrom((ws?.settings ?? {}) as Record<string, unknown>);
  cache.set(workspaceId, { at: Date.now(), policy });
  return policy;
}

export function forgetPolicy(workspaceId: string) {
  cache.delete(workspaceId);
}

// ─── IP allowlist ──────────────────────────────────────────────────────────────

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

function ipv6ToBig(ip: string): bigint {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const parts = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return parts.reduce((a, p) => (a << 16n) + BigInt(parseInt(p || "0", 16)), 0n);
}

/** True when `ip` matches one of `ranges` (exact IPs or CIDR blocks, IPv4 or IPv6). */
export function ipAllowed(ip: string, ranges: string[]): boolean {
  const addr = ip.replace(/^::ffff:/, "");
  for (const r of ranges) {
    const [net, bitsStr] = r.split("/");
    if (isIPv4(addr) && isIPv4(net)) {
      const bits = bitsStr === undefined ? 32 : Number(bitsStr);
      if (bits === 0) return true;
      const mask = (~0 << (32 - bits)) >>> 0;
      if ((ipv4ToInt(addr) & mask) === (ipv4ToInt(net) & mask)) return true;
    } else if (isIPv6(addr) && isIPv6(net)) {
      const bits = BigInt(bitsStr === undefined ? 128 : Number(bitsStr));
      const shift = 128n - bits;
      if (ipv6ToBig(addr) >> shift === ipv6ToBig(net) >> shift) return true;
    }
  }
  return false;
}

export function validRange(r: string): boolean {
  const [net, bits] = r.split("/");
  if (isIPv4(net)) return bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= 32);
  if (isIPv6(net)) return bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= 128);
  return false;
}

// ─── TOTP (RFC 6238) ───────────────────────────────────────────────────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Buffer {
  const clean = s.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32(randomBytes(20));

export function totpCode(secret: string, at = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = createHmac("sha1", unbase32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, "0");
}

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secret: string, code: string, at = Date.now()): boolean {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  return [-1, 0, 1].some((d) => totpCode(secret, at + d * 30_000) === c);
}

export const otpauthUrl = (secret: string, email: string) => `otpauth://totp/${encodeURIComponent(`Anvita:${email}`)}?secret=${secret}&issuer=Anvita&algorithm=SHA1&digits=6&period=30`;

export const newRecoveryCodes = () => Array.from({ length: 8 }, () => randomBytes(5).toString("hex").replace(/(.{5})/, "$1-"));

// ─── PII redaction ─────────────────────────────────────────────────────────────

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const PATTERNS: [RegExp, string | ((m: string) => string)][] = [
  // Card numbers (13-19 digits, Luhn-valid)
  [/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "[card]" : m)],
  // Aadhaar: 12 digits, not starting with 0/1
  [/\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g, "[aadhaar]"],
  // PAN
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[pan]"],
  // Indian mobile numbers
  [/(?<![\d+])(?:\+?91[ -]?)?[6-9]\d{4}[ -]?\d{5}\b/g, "[phone]"],
  // Bank account numbers when labelled
  [/\b((?:a\/c|acct|account)(?:\s*(?:no\.?|number|#))?\s*[:\-]?\s*)\d{9,18}\b/gi, "$1[account]"],
];

export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as string);
  return out;
}

/** Deep-redact strings inside any JSON value. */
export function redact<T>(v: T): T {
  if (typeof v === "string") return redactText(v) as T;
  if (Array.isArray(v)) return v.map(redact) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redact(x)])) as T;
  return v;
}

const CONSUMER = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com", "rediffmail.com", "aol.com"]);
export const isConsumerDomain = (d: string) => CONSUMER.has(d.toLowerCase());
