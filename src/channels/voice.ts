import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { messages, runs } from "../db/schema.js";
import { safeEqual } from "../lib/crypto.js";
import { routeInbound } from "./common.js";
import { endpointSecrets, endpointWorker, type Endpoint } from "./endpoints.js";

/**
 * Voice Workers over a phone number. The call is a loop of turns: the provider transcribes what
 * the caller said (speech gather), we run the Worker and speak its answer, then listen again.
 * Long answers keep the caller on the line ("one moment") and pick up the result on a redirect.
 *
 * Providers plug in through `VoiceProvider`. Twilio (and TwiML-compatible services such as
 * SignalWire and Telnyx TeXML) ships here; add Exotel, Plivo, Vonage… by implementing the same
 * interface and registering it in `VOICE_PROVIDERS`.
 */

export interface VoiceTurn {
  callId: string;
  from: string;
  /** What the caller said in this turn (empty on the first webhook or on silence). */
  speech: string;
}

export interface VoiceReply {
  say?: string;
  /** Listen for speech and POST it here. */
  gatherUrl?: string;
  /** Hold briefly then POST here (to pick up a slow answer). */
  redirectUrl?: string;
  hangup?: boolean;
  language: string;
  voice?: string;
}

export interface VoiceProvider {
  id: string;
  label: string;
  /** Check the request really comes from the provider (signature over URL + params). */
  verify(o: { url: string; params: Record<string, string>; headers: Record<string, string | string[] | undefined>; secrets: Record<string, string> }): boolean;
  parse(params: Record<string, string>): VoiceTurn;
  render(r: VoiceReply): { contentType: string; body: string };
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** Twilio: X-Twilio-Signature = base64(HMAC-SHA1(auth token, URL + each POST param name+value sorted by name)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

const twilio: VoiceProvider = {
  id: "twilio",
  label: "Twilio (and TwiML-compatible)",
  verify: ({ url, params, headers, secrets }) => {
    const sig = headers["x-twilio-signature"];
    return !!secrets.authToken && typeof sig === "string" && safeEqual(sig, twilioSignature(secrets.authToken, url, params));
  },
  parse: (p) => ({ callId: p.CallSid ?? "", from: p.From ?? "", speech: (p.SpeechResult ?? "").trim() }),
  render: (r) => {
    const voice = r.voice ? ` voice="${xml(r.voice)}"` : "";
    const say = r.say ? `<Say language="${xml(r.language)}"${voice}>${xml(r.say)}</Say>` : "";
    let body: string;
    if (r.gatherUrl) body = `<Gather input="speech" action="${xml(r.gatherUrl)}" method="POST" language="${xml(r.language)}" speechTimeout="auto">${say}</Gather><Redirect method="POST">${xml(r.gatherUrl)}</Redirect>`;
    else if (r.redirectUrl) body = `${say}<Pause length="1"/><Redirect method="POST">${xml(r.redirectUrl)}</Redirect>`;
    else body = `${say}${r.hangup ? "<Hangup/>" : ""}`;
    return { contentType: "text/xml", body: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>` };
  },
};

export const VOICE_PROVIDERS: Record<string, VoiceProvider> = { twilio };

export const voiceRef = (e: Endpoint, callId: string) => `voice:${e.id}:${callId}`;

/** Markdown → something a speech engine reads well. */
export function speakable(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>|]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
}

async function answerFor(runId: string, waitMs: number) {
  const until = Date.now() + waitMs;
  for (;;) {
    const [r] = await db.select({ status: runs.status, msg: runs.assistantMessageId, error: runs.error }).from(runs).where(eq(runs.id, runId));
    if (!r) return { done: true, text: "" };
    if (r.status !== "queued" && r.status !== "running") {
      const [m] = r.msg ? await db.select({ blocks: messages.blocks }).from(messages).where(eq(messages.id, r.msg)) : [];
      const text = ((m?.blocks ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n\n");
      if (r.status === "waiting_approval") return { done: true, text: `${text}\n\nI need a teammate to approve this. We'll message you as soon as it's done.` };
      if (r.status === "failed") return { done: true, text: "Sorry, something went wrong on our side. A teammate will call you back." };
      return { done: true, text };
    }
    if (Date.now() >= until) return { done: false, text: "" };
    await new Promise((res) => setTimeout(res, 250));
  }
}

export async function voiceTurn(e: Endpoint, step: "incoming" | "turn" | "wait", turn: VoiceTurn, query: { run?: string }) {
  const cfg = e.config as { language?: string; voice?: string; greeting?: string };
  const language = cfg.language ?? "en-IN";
  const base = `${config.PUBLIC_URL}/v1/hooks/voice/${e.key}`;
  const reply = (r: Omit<VoiceReply, "language">): VoiceReply => ({ language, voice: cfg.voice, ...r });

  if (step === "incoming") return reply({ say: cfg.greeting ?? `Hello, you've reached ${e.name}. How can I help you today?`, gatherUrl: `${base}/turn` });

  let runId = query.run;
  if (step === "turn") {
    if (!turn.speech) return reply({ say: "Sorry, I didn't catch that. Could you say it again?", gatherUrl: `${base}/turn` });
    if (/^(bye|goodbye|that'?s all|thank you,? bye)\b/i.test(turn.speech)) return reply({ say: "Thank you for calling. Goodbye!", hangup: true });
    const worker = await endpointWorker(e);
    const r = await routeInbound({ workspaceId: e.workspaceId, ref: voiceRef(e, turn.callId), title: `Call from ${turn.from || "unknown number"}`, channel: "voice", channelLabel: `Voice · ${e.name}`, workerId: worker?.id, author: turn.from || "Caller", text: turn.speech, trigger: "Voice" });
    if (r.handedOff || !r.run) return reply({ say: "Thanks. A teammate is handling your request and will get back to you shortly.", hangup: true });
    runId = r.run.id;
  }
  if (!runId) return reply({ gatherUrl: `${base}/turn` });
  const a = await answerFor(runId, config.VOICE_WAIT_MS);
  if (!a.done) return reply({ say: step === "turn" ? "One moment please." : undefined, redirectUrl: `${base}/wait?run=${encodeURIComponent(runId)}` });
  return reply({ say: speakable(a.text) || "Is there anything else I can help with?", gatherUrl: `${base}/turn` });
}

export { endpointSecrets };
