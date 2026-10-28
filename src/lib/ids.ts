import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase

export function randomString(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

/** Prefixed, URL-safe ids, e.g. `wrk_8f3k2m…`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomString(20)}`;
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 40) || "workspace";
}

/** Optional client-generated id (lets optimistic UIs navigate before the server responds). */
export const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
