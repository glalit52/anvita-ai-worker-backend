import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces } from "../db/schema.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";

/**
 * Per-workspace model settings (Settings → Models & data). Stored in workspace settings except
 * the bring-your-own API key, which is encrypted in its own column and never returned.
 *
 *   models.routing        "balanced" (default) | "quality" (chat and Workers use the Precise model)
 *                         | "economy" (planning uses the Balanced model)
 *   models.tier.fast      false → fast calls use the Balanced model
 *   models.tier.precise   false → planning uses the Balanced model
 *   models.webBrowsing    false → no web search tool
 *   models.fallback       false → no server-side fallback model when a request is declined
 */

export type Tier = "act" | "plan" | "fast";
export interface ModelSettings { routing: "balanced" | "quality" | "economy"; fast: boolean; precise: boolean; webBrowsing: boolean; fallback: boolean; apiKey: string | null }

const DEFAULTS: ModelSettings = { routing: "balanced", fast: true, precise: true, webBrowsing: true, fallback: true, apiKey: null };
const cache = new Map<string, { at: number; v: ModelSettings }>();

export async function modelSettings(workspaceId: string | undefined): Promise<ModelSettings> {
  if (!workspaceId) return DEFAULTS;
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < 10_000) return hit.v;
  const [w] = await db.select({ settings: workspaces.settings, key: workspaces.modelKeyEnc }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const s = w?.settings ?? {};
  let apiKey: string | null = null;
  try {
    apiKey = w?.key ? decrypt(w.key) : null;
  } catch {
    apiKey = null;
  }
  const routing = s["models.routing"];
  const v: ModelSettings = {
    routing: routing === "quality" || routing === "economy" ? routing : "balanced",
    fast: s["models.tier.fast"] !== false,
    precise: s["models.tier.precise"] !== false,
    webBrowsing: s["models.webBrowsing"] !== false,
    fallback: s["models.fallback"] !== false,
    apiKey,
  };
  cache.set(workspaceId, { at: Date.now(), v });
  return v;
}

export const forgetModelSettings = (workspaceId: string) => cache.delete(workspaceId);

/** The tier a call actually runs on after the workspace's routing choices. */
export function routeTier(tier: Tier, s: ModelSettings): Tier {
  let t = tier;
  if (s.routing === "quality" && t === "act") t = "plan";
  if (s.routing === "economy" && t === "plan") t = "act";
  if (t === "plan" && !s.precise) t = "act";
  if (t === "fast" && !s.fast) t = "act";
  return t;
}

/** Check a key against the Models API (cheap, no tokens) before saving it. */
export async function validateApiKey(apiKey: string) {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000 });
  try {
    const page = await client.models.list({ limit: 5 });
    return page.data.map((m) => m.id);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw badRequest("Anthropic rejected this key — check it's an active API key from console.anthropic.com");
    if (e instanceof Anthropic.APIError) throw badRequest(`Couldn't verify the key (Anthropic API ${e.status ?? "error"}). Try again shortly.`);
    throw badRequest("Couldn't reach the Anthropic API to verify the key");
  }
}

export async function saveApiKey(workspaceId: string, apiKey: string | null) {
  await db
    .update(workspaces)
    .set(apiKey ? { modelKeyEnc: encrypt(apiKey), modelKeyHint: apiKey.slice(-4), modelKeyAddedAt: new Date() } : { modelKeyEnc: null, modelKeyHint: null, modelKeyAddedAt: null })
    .where(eq(workspaces.id, workspaceId));
  forgetModelSettings(workspaceId);
}
