import { and, eq, sql } from "drizzle-orm";
import { appById } from "../catalog/index.js";
import { config } from "../config.js";
import { parseCredentials } from "../connectors/index.js";
import type { ChatBlock } from "../contracts/web.js";
import { db, type Tx } from "../db/client.js";
import { approvals, connections, messages, runs, threads } from "../db/schema.js";
import { postAssistantText, toSlack, toWhatsApp } from "./common.js";
import { sendEmailReply } from "./email.js";
import { sendTeams } from "./teams.js";
import { postToSlack } from "./slack.js";
import { sendWhatsApp } from "./whatsapp.js";

async function liveConnection(workspaceId: string, appId: string) {
  const [c] = await db.select().from(connections).where(and(eq(connections.workspaceId, workspaceId), eq(connections.appId, appId), eq(connections.mode, "live")));
  const credentials = c ? parseCredentials(c.credentialsEnc) : null;
  if (!c || !credentials) throw new Error(`${appById[appId]?.name ?? appId} is no longer connected`);
  return { ...c, credentials };
}

/** Send text into the channel conversation a thread mirrors (`slack:<channel>:<ts>` or `wa:<phone id>:<customer>`). */
export async function sendToChannel(workspaceId: string, threadRef: string, markdown: string): Promise<boolean> {
  if (threadRef.startsWith("slack:")) {
    await postToSlack(await liveConnection(workspaceId, "slack"), threadRef, toSlack(markdown));
    return true;
  }
  if (threadRef.startsWith("wa:")) {
    await sendWhatsApp(await liveConnection(workspaceId, "whatsapp"), threadRef.split(":")[2], toWhatsApp(markdown));
    return true;
  }
  if (threadRef.startsWith("teams:")) return sendTeams(threadRef, markdown);
  const [t] = await db.select({ id: threads.id, title: threads.title }).from(threads).where(and(eq(threads.workspaceId, workspaceId), eq(threads.externalRef, threadRef)));
  if (threadRef.startsWith("email:")) return sendEmailReply(threadRef, t?.title ?? "Your message", markdown);
  // Widget and voice read the thread itself: a teammate's reply becomes a message in it.
  if ((threadRef.startsWith("widget:") || threadRef.startsWith("voice:")) && t) {
    await postAssistantText(workspaceId, t.id, "Support team", markdown);
    return true;
  }
  return false;
}

/** Channels that read answers straight from the thread don't need run delivery. */
const pulls = (ref: string) => ref.startsWith("widget:") || ref.startsWith("voice:");

/**
 * After a channel-originated run finishes or pauses, post what's new in the assistant message
 * back to Slack/WhatsApp: the answer, links to files, and what's needed to continue. Customers
 * only ever see the answer itself.
 */
export async function deliverRun(runId: string) {
  // Serialize deliveries per run so a pause notice and the final answer never double-post.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"deliver:" + runId}))`);
    await deliverLocked(runId, tx);
  });
}

async function deliverLocked(runId: string, db: Tx) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run?.threadId || !run.assistantMessageId) return;
  const [thread] = await db.select().from(threads).where(eq(threads.id, run.threadId));
  if (!thread?.externalRef || pulls(thread.externalRef)) return;
  const [msg] = await db.select().from(messages).where(eq(messages.id, run.assistantMessageId));
  const blocks = (msg?.blocks ?? []) as ChatBlock[];
  const delivered = run.deliveredBlocks;
  const link = `${config.WEB_URL}/chat/${thread.id}`;
  const customer = !!(run.input as { customer?: boolean }).customer;
  const parts: string[] = [];
  for (const b of blocks.slice(delivered)) {
    if (b.type === "text" && b.text.trim()) parts.push(b.text.trim());
    else if (customer) continue;
    else if (b.type === "artifact") parts.push(`📎 [${b.artifact.title}](${link})`);
    else if (b.type === "approval") {
      const [a] = await db.select().from(approvals).where(eq(approvals.id, b.approvalId));
      parts.push(`⏳ Waiting for approval: **${a?.title ?? "action"}** — [review it](${config.WEB_URL}/approvals)`);
    } else if (b.type === "connect" && b.status === "pending") parts.push(`🔌 Connect ${appById[b.appId]?.name ?? b.appId} to continue — [open the chat](${link})`);
  }
  if (customer && run.status === "waiting_approval" && !parts.length) parts.push("Thanks for your patience — I'm checking this with the team and will update you here shortly.");
  if (run.status === "failed" && !parts.length) parts.push(customer ? "Sorry, something went wrong on our side. A teammate will get back to you shortly." : `⚠️ I couldn't finish: ${run.error ?? "unknown error"}`);
  if (!parts.length) return;
  await sendToChannel(run.workspaceId, thread.externalRef, parts.join("\n\n"));
  await db.update(runs).set({ deliveredBlocks: blocks.length }).where(eq(runs.id, run.id));
}
