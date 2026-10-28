import { db } from "../db/client.js";
import { artifacts } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { describeFile } from "../sandbox/index.js";

type ArtifactRow = typeof artifacts.$inferSelect;

/** Text formats are stored as UTF-8; everything else as base64 (see /artifacts/:id/content). */
export function isTextMime(mime: string) {
  return /^(text\/|application\/(json|csv|xml|x-yaml|markdown))/.test(mime) || mime === "image/svg+xml";
}

export function artifactCard(a: ArtifactRow) {
  return { id: a.id, kind: a.kind, title: a.title, subtitle: a.subtitle ?? undefined, size: `${Math.max(1, Math.round(a.sizeBytes / 1024))} KB`, createdAt: a.createdAt.toISOString() };
}

/** Save a generated file (sandbox output, workflow export…) as a downloadable artifact. */
export async function saveFileArtifact(o: { workspaceId: string; runId?: string | null; threadId?: string | null; name: string; data: Buffer; subtitle?: string }) {
  const { mime, kind, text } = describeFile(o.name);
  const [row] = await db
    .insert(artifacts)
    .values({ id: newId("art"), workspaceId: o.workspaceId, runId: o.runId ?? null, threadId: o.threadId ?? null, kind, title: o.name, subtitle: o.subtitle ?? null, mime, sizeBytes: o.data.length, content: text ? o.data.toString("utf8") : o.data.toString("base64") })
    .returning();
  return row;
}

/** Bytes of an artifact (for passing files into the sandbox). */
export function artifactBytes(a: ArtifactRow): Buffer {
  return isTextMime(a.mime) ? Buffer.from(a.content, "utf8") : Buffer.from(a.content, "base64");
}
