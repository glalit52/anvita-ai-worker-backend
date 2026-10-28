import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config.js";
import { badRequest } from "./errors.js";

/**
 * SSRF guard for user-supplied URLs (workflow webhooks, imported APIs, MCP servers): https only,
 * and the host must resolve to public addresses. Plain http to localhost is allowed outside
 * production for local development.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`Invalid URL: ${raw}`);
  }
  const devLocal = config.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (devLocal) return url;
  if (url.protocol !== "https:") throw badRequest("Only https:// URLs are allowed");
  if (url.username || url.password) throw badRequest("URLs must not contain credentials");
  if (config.NODE_ENV === "production" || process.env.SSRF_STRICT === "1") {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addrs.length) throw badRequest(`Couldn't resolve ${host}`);
    for (const a of addrs) if (isPrivateAddress(a)) throw badRequest(`${host} resolves to a private address`);
  }
  return url;
}

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
