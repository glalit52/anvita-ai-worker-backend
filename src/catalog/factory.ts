// Ported from the web app (apps/web/src/components/workers/factory.ts) so graphs are generated server-side.
import type { InteractionType, Template, Thread, Worker, WorkerEdge, WorkerNode } from "../contracts/web.js";
import { appById } from "./index.js";
import { TOOLS } from "../runtime/tools/index.js";
import { workflowTemplateById } from "../workflow/templates.js";

const uid = () => Math.random().toString(36).slice(2, 8);

const keywordApps: [RegExp, string][] = [
  [/whatsapp/i, "whatsapp"],
  [/slack|#\w+/i, "slack"],
  [/teams/i, "teams"],
  [/e-?mail|gmail|inbox/i, "gmail"],
  [/drive|docs?\b|sheet/i, "gdrive"],
  [/hubspot|lead|deal|crm|pipeline/i, "hubspot"],
  [/salesforce/i, "salesforce"],
  [/zendesk|ticket/i, "zendesk"],
  [/shopify|order|return|sku|product/i, "shopify"],
  [/refund|payment|upi|razorpay|payout/i, "razorpay"],
  [/tally|gst|voucher|invoice|ledger/i, "tally"],
  [/meta|facebook|instagram|ads?\b|roas/i, "metaads"],
  [/google ads/i, "googleads"],
  [/calendar|meeting|interview|schedule/i, "gcal"],
  [/okta|password|access/i, "okta"],
  [/jira|issue|bug/i, "jira"],
  [/research|web|competitor|news/i, "web"],
  [/delivery|tracking|courier|rto|delhivery/i, "delhivery"],
];

export function guessApps(text: string) {
  const found = keywordApps.filter(([re]) => re.test(text)).map(([, a]) => a);
  return Array.from(new Set(found)).slice(0, 5);
}

function guessInteraction(text: string): InteractionType {
  if (/every|daily|weekly|monthly|each (day|week|month)|on the \d+/i.test(text)) return "scheduled";
  if (/call|phone|voice/i.test(text)) return "voice";
  if (/invoice|document|résumé|resume|queue|review/i.test(text)) return "queue";
  if (/api|webhook/i.test(text)) return "api";
  return "chat";
}

function titleFrom(text: string) {
  const cleaned = text
    .replace(/^(every|when|each)\b[^,]*,\s*/i, "")
    .replace(/[.;].*$/, "")
    .trim();
  const words = cleaned.split(/\s+/).slice(0, 5).join(" ");
  const t = words.charAt(0).toUpperCase() + words.slice(1);
  return t.length > 40 ? t.slice(0, 38) + "…" : t || "New AI Worker";
}

const emojiFor: Record<InteractionType, string> = { chat: "💬", queue: "📥", voice: "📞", api: "🔌", document: "📄", scheduled: "🗓️" };
const colorFor: Record<InteractionType, string> = { chat: "#25D366", queue: "#0C7A5A", voice: "#0284C7", api: "#334155", document: "#DB2777", scheduled: "#5B4CF0" };

function triggerTitle(interaction: InteractionType, text: string) {
  if (interaction === "scheduled") {
    const m = text.match(/every\s+(\w+)/i) || text.match(/on the (\d+\w*)/i);
    return m ? `Every ${m[1]}` : "Every Monday 09:00 IST";
  }
  if (interaction === "voice") return "Inbound call";
  if (interaction === "queue") return "New item arrives";
  if (interaction === "api") return "API call";
  return "New message";
}

/** Generates a sensible linear-with-branch graph for a description. */
export function graphFor(text: string, apps: string[], interaction: InteractionType): { nodes: WorkerNode[]; edges: WorkerEdge[] } {
  const nodes: WorkerNode[] = [];
  const edges: WorkerEdge[] = [];
  const x = 260;
  let y = 0;
  const add = (n: Omit<WorkerNode, "x" | "y" | "id">, dx = 0) => {
    const id = `${n.kind}-${uid()}`;
    nodes.push({ ...n, id, x: x + dx, y });
    y += 130;
    return id;
  };
  const link = (a: string, b: string, label?: string) => edges.push({ id: `${a}-${b}`, source: a, target: b, label });

  const channelApp = apps.find((a) => ["whatsapp", "slack", "teams", "gmail"].includes(a));
  const t = add({ kind: "trigger", title: triggerTitle(interaction, text), subtitle: interaction === "scheduled" ? "Schedule · Asia/Kolkata" : channelApp ? appById[channelApp]?.name : "Trigger", appId: interaction === "scheduled" ? undefined : channelApp, config: { triggerType: interaction === "scheduled" ? "schedule" : interaction === "api" ? "api" : interaction === "queue" ? "queue" : "channel" } });
  const toolApps = apps.filter((a) => a !== channelApp);
  // Apps with a real read action get their own step; the rest become tools of the AI step.
  const readable = toolApps.filter((a) => readAction(a)).slice(0, 3);
  const agentTools = toolApps.filter((a) => !readable.includes(a) && !["web"].includes(a));
  const reads = readable.map((a, i) => {
    const action = readAction(a)!;
    const id = add({ kind: "tool", title: `Fetch from ${appById[a]?.name ?? a}`, subtitle: action, appId: a, config: { action, sideEffect: "none" } }, (i - (readable.length - 1) / 2) * 240);
    link(t, id);
    y -= 130;
    return id;
  });
  if (reads.length) y += 130;
  const ag = add({ kind: "agent", title: "Understand & decide", subtitle: "Balanced (Sonnet)", config: { model: "Balanced (Sonnet)", instructions: text, tools: agentTools } });
  for (const r of reads.length ? reads : [t]) link(r, ag);
  const needsApproval = /approv|refund|payment|send|email|post|over|above|>/i.test(text);
  let last = ag;
  if (needsApproval) {
    const ap = add({ kind: "approval", title: "Human approval", subtitle: "Owner · 24h timeout", config: { approvers: "Role: Owner", timeout: "24h", condition: "always" } });
    link(ag, ap);
    last = ap;
  }
  const writeApp = [toolApps[2], ...toolApps].find((a) => a && writeAction(a));
  if (writeApp && /create|update|post|refund|ticket|voucher|draft|issue/i.test(text)) {
    const action = writeAction(writeApp)!;
    const w = add({ kind: "tool", title: `Write to ${appById[writeApp]?.name ?? writeApp}`, subtitle: action, appId: writeApp, config: { action, sideEffect: "write" } });
    link(last, w, needsApproval ? "approved" : undefined);
    last = w;
  }
  const slackChannel = /#[\w-]+/.exec(text)?.[0];
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text)?.[0];
  const sendCfg = channelApp && interaction !== "scheduled" ? { channel: "reply" } : email ? { channel: "gmail", to: email, subject: titleFrom(text) } : { channel: "slack", to: slackChannel ?? "#general" };
  const sendApp = sendCfg.channel === "reply" ? channelApp : sendCfg.channel;
  const s = add({ kind: "send", title: sendCfg.channel === "reply" ? `Reply on ${appById[channelApp!]?.name}` : `Send to ${sendCfg.to}`, subtitle: sendCfg.channel === "reply" ? "Same channel" : appById[sendApp ?? ""]?.name, appId: sendApp, config: sendCfg });
  link(last, s, needsApproval && last !== ag && !writeApp ? "approved" : undefined);
  const e = add({ kind: "end", title: "Log outcome" });
  link(s, e);
  return { nodes, edges };
}

/** The first real read / write action an app offers (from the tool registry). */
export function readAction(appId: string) {
  return TOOLS.find((t) => t.appId === appId && t.kind === "tool" && t.sideEffect === "none")?.action;
}
export function writeAction(appId: string) {
  return TOOLS.find((t) => t.appId === appId && t.kind === "tool" && t.sideEffect !== "none")?.action;
}

function base(partial: Partial<Worker> & Pick<Worker, "name" | "description" | "interaction" | "nodes" | "edges" | "apps">, owner: string): Worker {
  return {
    id: `w-${uid()}`,
    emoji: emojiFor[partial.interaction],
    color: colorFor[partial.interaction],
    channels: [],
    status: "draft",
    version: 0,
    owner,
    trigger: partial.nodes[0]?.title ?? "Manual",
    runs30d: 0,
    successRate: 0,
    avgCredits: 0,
    hoursSaved30d: 0,
    lastRun: "—",
    ...partial,
  };
}

export function workerFromDescription(text: string, owner: string): Worker {
  const apps = guessApps(text);
  const interaction = guessInteraction(text);
  const { nodes, edges } = graphFor(text, apps, interaction);
  return base(
    {
      name: titleFrom(text),
      description: text,
      interaction,
      apps: apps.length ? apps : ["slack"],
      channels: apps.filter((a) => ["whatsapp", "slack", "teams", "gmail"].includes(a)).map((a) => appById[a]?.name ?? a),
      nodes,
      edges,
      createdFrom: "autopilot",
    },
    owner,
  );
}

export function workerFromTemplate(tpl: Template, owner: string): Worker {
  const wf = workflowTemplateById[tpl.id];
  const graph = wf ? { nodes: structuredClone(wf.nodes), edges: structuredClone(wf.edges) } : graphFor(tpl.description, tpl.apps, tpl.interaction);
  const w = base(
    {
      name: tpl.name,
      description: tpl.description,
      emoji: tpl.emoji,
      color: tpl.color,
      interaction: tpl.interaction,
      apps: tpl.apps,
      channels: wf?.channels ?? [],
      trigger: wf?.trigger ?? graph.nodes[0]?.title ?? "Manual",
      ...graph,
      createdFrom: "template",
    },
    owner,
  );
  return wf?.instructions ? Object.assign(w, { instructions: wf.instructions }) : w;
}

export function workerFromThread(thread: Thread, owner: string): Worker {
  const firstUser = thread.messages.find((m) => m.role === "user");
  const text = firstUser?.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ") || thread.title;
  const w = workerFromDescription(text, owner);
  return { ...w, name: thread.title.length > 40 ? thread.title.slice(0, 38) + "…" : thread.title, createdFrom: "run" };
}

export function blankWorker(owner: string): Worker {
  return base(
    {
      name: "Untitled Worker",
      description: "Describe what this Worker does.",
      interaction: "chat",
      apps: [],
      nodes: [{ id: `trigger-${uid()}`, kind: "trigger", title: "New message", subtitle: "Choose a trigger", x: 260, y: 0 }],
      edges: [],
      createdFrom: "scratch",
    },
    owner,
  );
}

/** Compiles an agent run (thread) into a Worker graph: tool steps → app actions, code → frozen code, LLM → agent, approvals kept. */
export function compileThread(thread: Thread, name: string, owner: string, schedule: string): Worker {
  const steps = thread.messages.flatMap((m) => m.blocks.flatMap((b) => (b.type === "steps" ? b.steps : [])));
  const hasApproval = thread.messages.some((m) => m.blocks.some((b) => b.type === "approval"));
  const nodes: WorkerNode[] = [];
  const edges: WorkerEdge[] = [];
  const x = 260;
  let y = 0;
  const push = (n: Omit<WorkerNode, "x" | "y" | "id">, dx = 0, advance = true) => {
    const id = `${n.kind}-${uid()}`;
    nodes.push({ ...n, id, x: x + dx, y });
    if (advance) y += 140;
    return id;
  };
  const trigger = push({ kind: "trigger", title: schedule, subtitle: "Schedule · Asia/Kolkata", config: { cron: "0 9 * * MON", timezone: "Asia/Kolkata" } });
  const tools = steps.filter((s) => s.kind === "tool" && s.appId);
  const readable = tools.filter((s) => readAction(s.appId!));
  const toolIds = readable.map((s, i) => push({ kind: "tool", title: s.label.replace(/^(Fetched|Searched|Queried|Pulled|Exported|Researched|Checked)\s+/i, ""), subtitle: readAction(s.appId!), appId: s.appId, config: { action: readAction(s.appId!)!, sideEffect: "none", range: "{{ trigger.range ?? 'last_7d' }}" } }, (i - (readable.length - 1) / 2) * 260, false));
  if (readable.length) y += 140;
  toolIds.forEach((id) => edges.push({ id: `${trigger}-${id}`, source: trigger, target: id }));
  const code = push({ kind: "code", title: "Analysis script (frozen)", subtitle: "Compiled from this run · no LLM cost", appId: "sandbox", config: { language: "python", frozen: true } });
  (toolIds.length ? toolIds : [trigger]).forEach((id) => edges.push({ id: `${id}-${code}`, source: id, target: code }));
  const agent = push({ kind: "agent", title: "Write summary", subtitle: "Balanced (Sonnet) · output schema", config: { model: "Balanced (Sonnet)", instructions: "Summarise the results in 3 bullets and flag anomalies." } });
  edges.push({ id: `${code}-${agent}`, source: code, target: agent });
  let last = agent;
  if (hasApproval) {
    const ap = push({ kind: "approval", title: "Owner approval", subtitle: "24h timeout", config: { approvers: "role:owner", timeout: "24h" } });
    edges.push({ id: `${last}-${ap}`, source: last, target: ap });
    last = ap;
  }
  const send = push({ kind: "send", title: thread.channel === "slack" ? "Post results to #general" : "Email the results", subtitle: thread.channel === "slack" ? "Slack" : "Email", appId: thread.channel === "slack" ? "slack" : "gmail", config: thread.channel === "slack" ? { channel: "slack", to: "#general" } : { channel: "gmail", to: "{{ trigger.email ?? '' }}", subject: name } });
  edges.push({ id: `${last}-${send}`, source: last, target: send, label: hasApproval ? "approved" : undefined });
  const end = push({ kind: "end", title: "Done" });
  edges.push({ id: `${send}-${end}`, source: send, target: end });
  const apps = Array.from(new Set(tools.map((t) => t.appId!).concat(thread.channel === "slack" ? ["slack"] : ["gmail"])));
  return base(
    {
      name,
      description: `Compiled from the chat “${thread.title}”. Runs ${schedule.toLowerCase()} and delivers the same output.`,
      interaction: "scheduled",
      emoji: "📈",
      color: "#5B4CF0",
      apps,
      channels: [thread.channel === "slack" ? "Slack" : "Email"],
      trigger: schedule,
      status: "live",
      version: 1,
      nodes,
      edges,
      createdFrom: "run",
    },
    owner,
  );
}
