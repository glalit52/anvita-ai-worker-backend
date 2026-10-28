import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { config, embeddingsProvider } from "../config.js";
import { db } from "../db/client.js";

/**
 * Embeddings for knowledge search. Vectors are 1024-dimensional for every provider (Voyage and
 * OpenAI both support choosing the output size), stored in `kb_embeddings` (pgvector, HNSW).
 */

export const EMBED_DIM = 1024;
const BATCH = 64;

export function embeddingModel(): string {
  const p = embeddingsProvider();
  return config.EMBEDDINGS_MODEL ?? (p === "voyage" ? "voyage-3.5" : p === "openai" ? "text-embedding-3-small" : p === "hash" ? "hash-v1" : "none");
}

let ready: { at: number; ok: boolean } | null = null;
/** pgvector installed and the embeddings table present (cached for a minute). */
export async function vectorsReady(): Promise<boolean> {
  if (embeddingsProvider() === "none") return false;
  if (ready && Date.now() - ready.at < 60_000) return ready.ok;
  const rows = (await db.execute(sql`select to_regclass('public.kb_embeddings') is not null as ok`)) as unknown as { ok: boolean }[];
  ready = { at: Date.now(), ok: !!rows[0]?.ok };
  return ready.ok;
}

/** Deterministic keyword-hashing embedding (words + character trigrams), L2-normalised. */
function hashEmbed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const add = (tok: string, w: number) => {
    const h = createHash("md5").update(tok).digest();
    v[h.readUInt32LE(0) % EMBED_DIM] += h[4] & 1 ? w : -w;
  };
  for (const word of words) {
    add(`w:${word}`, 1);
    const p = `#${word}#`;
    for (let i = 0; i + 3 <= p.length; i++) add(`t:${p.slice(i, i + 3)}`, 0.35);
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

async function remote(url: string, key: string, body: unknown): Promise<number[][]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as { data?: { embedding: number[]; index: number }[]; detail?: string; error?: { message?: string } };
    if (!res.ok || !data.data) throw new Error(`Embeddings API error ${res.status}: ${data.detail ?? data.error?.message ?? ""}`.trim());
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export async function embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
  const p = embeddingsProvider();
  if (!texts.length || p === "none") return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 16_000));
    if (p === "hash") out.push(...batch.map(hashEmbed));
    else if (p === "voyage") out.push(...(await remote("https://api.voyageai.com/v1/embeddings", config.VOYAGE_API_KEY ?? "", { input: batch, model: embeddingModel(), input_type: kind, output_dimension: EMBED_DIM })));
    else out.push(...(await remote("https://api.openai.com/v1/embeddings", config.OPENAI_API_KEY ?? "", { input: batch, model: embeddingModel(), dimensions: EMBED_DIM })));
  }
  return out;
}

const vec = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;

/** Embed chunks that don't have a vector yet (optionally for one document). Returns how many were embedded. */
export async function embedMissing(opts: { documentId?: string; workspaceId?: string; limit?: number } = {}): Promise<number> {
  if (!(await vectorsReady())) return 0;
  const limit = Math.min(opts.limit ?? 512, 2000);
  const rows = (await db.execute(sql`
    select c.id, c.workspace_id, c.kb_id, d.title, c.content
    from kb_chunks c join kb_documents d on d.id = c.document_id
    left join kb_embeddings e on e.chunk_id = c.id
    where e.chunk_id is null
      ${opts.documentId ? sql`and c.document_id = ${opts.documentId}` : sql``}
      ${opts.workspaceId ? sql`and c.workspace_id = ${opts.workspaceId}` : sql``}
    order by c.document_id, c.seq
    limit ${limit}`)) as unknown as { id: string; workspace_id: string; kb_id: string; title: string; content: string }[];
  if (!rows.length) return 0;
  const model = embeddingModel();
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // The title gives short chunks context ("Return policy — Items can be returned within 7 days…").
    const vectors = await embed(batch.map((r) => `${r.title}\n\n${r.content}`), "document");
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j];
      await db.execute(sql`insert into kb_embeddings (chunk_id, workspace_id, kb_id, model, embedding) values (${r.id}, ${r.workspace_id}, ${r.kb_id}, ${model}, ${vec(vectors[j])}::vector) on conflict (chunk_id) do nothing`);
    }
  }
  return rows.length;
}

const queryCache = new Map<string, number[]>();
export async function embedQuery(q: string): Promise<number[] | null> {
  const key = `${embeddingModel()}:${q}`;
  const hit = queryCache.get(key);
  if (hit) return hit;
  const [v] = await embed([q], "query");
  if (!v) return null;
  if (queryCache.size > 500) queryCache.clear();
  queryCache.set(key, v);
  return v;
}

/** Nearest chunks by cosine distance within a workspace (and optional knowledge bases). */
export async function vectorSearch(workspaceId: string, q: string, opts: { kbIds?: string[]; limit: number }): Promise<{ chunkId: string; distance: number }[]> {
  if (!(await vectorsReady())) return [];
  const v = await embedQuery(q);
  if (!v) return [];
  const rows = (await db.execute(sql`
    select chunk_id, embedding <=> ${vec(v)}::vector as distance
    from kb_embeddings
    where workspace_id = ${workspaceId} and model = ${embeddingModel()}
      ${opts.kbIds?.length ? sql`and kb_id in ${opts.kbIds}` : sql``}
    order by embedding <=> ${vec(v)}::vector
    limit ${opts.limit}`)) as unknown as { chunk_id: string; distance: number }[];
  return rows.map((r) => ({ chunkId: r.chunk_id, distance: Number(r.distance) }));
}
