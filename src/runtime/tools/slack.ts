/** Live Slack driver (chat.postMessage) used when a Slack connection has a bot token. */
export async function slackPostMessage(botToken: string, channel: string, text: string): Promise<Record<string, unknown>> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: channel.replace(/^#/, ""), text }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
  if (!body.ok) throw new Error(`Slack error: ${body.error ?? res.status}`);
  return { sent: true, ts: body.ts, channel: body.channel };
}
