import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { kbChunks, kbDocuments, knowledgeBases } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { enqueue } from "../jobs/queue.js";
import { vectorSearch, vectorsReady } from "./embeddings.js";

/** Structure-aware-ish chunking: split on paragraphs, pack to ~maxChars with overlap. */
export function chunkText(text: string, maxChars = 2400, overlap = 200): string[] {
  const paras = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = cur.slice(-overlap);
  };
  for (const p of paras) {
    if (p.length > maxChars) {
      flush();
      for (let i = 0; i < p.length; i += maxChars - overlap) chunks.push(p.slice(i, i + maxChars));
      cur = "";
      continue;
    }
    if (cur.length + p.length + 2 > maxChars) flush();
    cur += (cur ? "\n\n" : "") + p;
  }
  if (cur.trim() && (!chunks.length || !chunks[chunks.length - 1].endsWith(cur.trim()))) chunks.push(cur.trim());
  return chunks;
}

export async function ingestDocument(input: { workspaceId: string; kbId: string; title: string; content: string; mime?: string; url?: string | null; sourceId?: string | null }) {
  const parts = chunkText(input.content);
  const docId = newId("doc");
  await db.transaction(async (tx) => {
    await tx.insert(kbDocuments).values({ id: docId, kbId: input.kbId, workspaceId: input.workspaceId, title: input.title, mime: input.mime ?? "text/plain", url: input.url ?? null, sourceId: input.sourceId ?? null, bytes: Buffer.byteLength(input.content), chunks: parts.length });
    if (parts.length) await tx.insert(kbChunks).values(parts.map((content, seq) => ({ id: newId("chk"), documentId: docId, kbId: input.kbId, workspaceId: input.workspaceId, seq, content })));
    await tx.update(knowledgeBases).set({ updatedAt: new Date() }).where(eq(knowledgeBases.id, input.kbId));
  });
  if (parts.length && (await vectorsReady())) await enqueue("kb.embed", { documentId: docId }, { maxAttempts: 5 });
  return { id: docId, chunks: parts.length };
}

export interface SearchHit { chunkId: string; documentId: string; kbId: string; title: string; content: string; score: number; match?: "keyword" | "semantic" | "both" }

async function lexicalSearch(workspaceId: string, query: string, opts: { kbIds?: string[]; limit: number }) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return [];
  const tsq = words.map((w) => `${w.replace(/'/g, "")}:*`).join(" | ");
  const conds = [eq(kbChunks.workspaceId, workspaceId), sql`${kbChunks.tsv} @@ to_tsquery('simple', ${tsq})`];
  if (opts.kbIds?.length) conds.push(inArray(kbChunks.kbId, opts.kbIds));
  const rows = await db
    .select({ chunkId: kbChunks.id, documentId: kbChunks.documentId, kbId: kbChunks.kbId, title: kbDocuments.title, content: kbChunks.content, score: sql<number>`ts_rank_cd(${kbChunks.tsv}, to_tsquery('simple', ${tsq}))` })
    .from(kbChunks)
    .innerJoin(kbDocuments, eq(kbDocuments.id, kbChunks.documentId))
    .where(and(...conds))
    .orderBy(sql`5 desc`)
    .limit(opts.limit);
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/**
 * Hybrid search: Postgres full-text (`simple` config, so Hindi/Hinglish tokens survive) plus
 * pgvector semantic neighbours, merged with reciprocal rank fusion. Falls back to keyword-only
 * when embeddings aren't configured.
 */
export async function searchKnowledge(workspaceId: string, query: string, opts: { kbIds?: string[]; limit?: number } = {}): Promise<SearchHit[]> {
  const limit = Math.min(opts.limit ?? 6, 20);
  const pool = Math.max(limit * 4, 20);
  const [lex, sem] = await Promise.all([lexicalSearch(workspaceId, query, { kbIds: opts.kbIds, limit: pool }), vectorSearch(workspaceId, query, { kbIds: opts.kbIds, limit: pool }).catch(() => [])]);
  if (!sem.length) return lex.slice(0, limit).map((h) => ({ ...h, match: "keyword" as const }));
  const K = 60;
  const fused = new Map<string, { score: number; lex: boolean; sem: boolean }>();
  lex.forEach((h, i) => fused.set(h.chunkId, { score: 1 / (K + i + 1), lex: true, sem: false }));
  sem.forEach((h, i) => {
    const cur = fused.get(h.chunkId) ?? { score: 0, lex: false, sem: false };
    // Only reasonably close neighbours count — avoids padding results with unrelated chunks.
    if (h.distance > 0.85 && !cur.lex) return;
    fused.set(h.chunkId, { score: cur.score + 1 / (K + i + 1), lex: cur.lex, sem: true });
  });
  const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  const missing = top.map(([id]) => id).filter((id) => !lex.some((h) => h.chunkId === id));
  const extra = missing.length
    ? await db.select({ chunkId: kbChunks.id, documentId: kbChunks.documentId, kbId: kbChunks.kbId, title: kbDocuments.title, content: kbChunks.content }).from(kbChunks).innerJoin(kbDocuments, eq(kbDocuments.id, kbChunks.documentId)).where(and(eq(kbChunks.workspaceId, workspaceId), inArray(kbChunks.id, missing)))
    : [];
  const byId = new Map([...lex, ...extra.map((x) => ({ ...x, score: 0 }))].map((h) => [h.chunkId, h]));
  return top.flatMap(([id, f]) => {
    const h = byId.get(id);
    return h ? [{ ...h, score: Math.round(f.score * 10000) / 10000, match: f.lex && f.sem ? ("both" as const) : f.lex ? ("keyword" as const) : ("semantic" as const) }] : [];
  });
}
