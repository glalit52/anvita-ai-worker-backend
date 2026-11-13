import { eq, inArray } from "drizzle-orm";
import webpush from "web-push";
import { config } from "../config.js";
import { db, type Tx } from "../db/client.js";
import { pushSubscriptions } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { enqueue } from "../jobs/queue.js";

/**
 * Browser push (Web Push with VAPID keys). Every in-app notification is also pushed to the
 * recipient's subscribed browsers, so approvals reach people with Anvita closed.
 */

export const pushEnabled = () => !!(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
if (pushEnabled()) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!);

export interface PushJob { userIds: string[]; title: string; body: string; href: string; tag?: string }

export async function subscribePush(userId: string, s: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string) {
  await db
    .insert(pushSubscriptions)
    .values({ id: newId("psh"), userId, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId, p256dh: s.keys.p256dh, auth: s.keys.auth } });
}

export const unsubscribePush = (endpoint: string) => db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));

/** Queue a push for these users if any of them has a subscribed browser. */
export async function queuePush(job: PushJob, tx: Tx = db) {
  if (!pushEnabled() || !job.userIds.length) return;
  const [any] = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(inArray(pushSubscriptions.userId, job.userIds)).limit(1);
  if (any) await enqueue("push.send", job as unknown as Record<string, unknown>, { maxAttempts: 2 }, tx);
}

export async function sendPush(job: PushJob) {
  if (!pushEnabled()) return;
  const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, job.userIds));
  const body = JSON.stringify({ title: job.title, body: job.body, url: `${config.WEB_URL}${job.href}`, tag: job.tag });
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 24 * 3600, urgency: "high" });
    } catch (e) {
      // Gone / not found: the browser dropped the subscription.
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
    }
  }
}
