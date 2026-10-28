import { and, asc, eq } from "drizzle-orm";
import type { ChatBlock } from "../../contracts/web.js";
import { db } from "../../db/client.js";
import { inboxConversations, messages, threads } from "../../db/schema.js";
import { newId } from "../../lib/ids.js";
import { publish } from "../../services/events.js";
import { notify } from "../../services/notifications.js";
import { serializeInbox } from "../../services/serializers.js";
import type { ToolDef } from "./types.js";

/** Customer-facing runs only: hand the conversation to a person in the Anvita inbox. */
export const HANDOFF_TOOL: ToolDef = {
  name: "handoff_to_human",
  action: "inbox.handoff",
  appId: "anvita",
  kind: "tool",
  description: "Hand this customer conversation to a human teammate. Use when the customer asks for a person, is upset, or you can't resolve the request within policy. Afterwards, tell the customer a teammate will reply here shortly.",
  inputSchema: { type: "object", properties: { reason: { type: "string", description: "Short reason, e.g. 'Refund dispute'" }, summary: { type: "string", description: "2-3 sentence summary for the teammate" }, sentiment: { type: "string", enum: ["negative", "neutral", "positive"] }, language: { type: "string" } }, required: ["reason", "summary"] },
  sideEffect: "none",
  needsConnection: false,
  label: () => "Handed off to the team",
  execute: async (input: { reason: string; summary: string; sentiment?: "negative" | "neutral" | "positive"; language?: string }, ctx) => {
    const [thread] = await db.select().from(threads).where(eq(threads.id, ctx.threadId ?? ""));
    if (!thread) throw new Error("Handoff needs a conversation");
    const history = await db.select().from(messages).where(eq(messages.threadId, thread.id)).orderBy(asc(messages.createdAt));
    const transcript = history.flatMap((m) =>
      (m.blocks as ChatBlock[]).filter((b) => b.type === "text").map((b) => ({ from: m.role === "user" ? ("customer" as const) : ("worker" as const), text: (b as { text: string }).text, time: m.createdAt.toISOString() })),
    );
    const customer = thread.title.replace(/ · WhatsApp$/, "");
    const phone = thread.externalRef?.startsWith("wa:") ? `+${thread.externalRef.split(":")[2]}` : "";
    const values = { reason: input.reason.slice(0, 300), summary: input.summary.slice(0, 2000), sentiment: input.sentiment ?? "neutral", language: input.language ?? "English", transcript, status: "open" as const, assigneeId: null, assigneeName: null, waitingSince: new Date(), updatedAt: new Date() };
    const [existing] = await db.select().from(inboxConversations).where(and(eq(inboxConversations.workspaceId, ctx.workspaceId), eq(inboxConversations.threadId, thread.id)));
    const [row] = existing
      ? await db.update(inboxConversations).set(values).where(eq(inboxConversations.id, existing.id)).returning()
      : await db.insert(inboxConversations).values({ id: newId("inb"), workspaceId: ctx.workspaceId, threadId: thread.id, workerId: thread.workerId, workerName: ctx.actor.name, customer, phone, channel: thread.channel === "whatsapp" ? "whatsapp" : "widget", ...values }).returning();
    await publish({ workspaceId: ctx.workspaceId, type: "inbox.updated", data: serializeInbox(row) });
    await notify({ workspaceId: ctx.workspaceId, appId: thread.channel === "whatsapp" ? "whatsapp" : "anvita", title: `${customer} needs a human: ${input.reason}`, meta: `${ctx.actor.name} · just now`, href: "/inbox", minRole: "member" });
    return { output: { handed_off: true, inbox_id: row.id }, summary: input.reason, credits: 0 };
  },
};
