import { eq } from "drizzle-orm";
import { modelProvider } from "../config.js";
import { db } from "../db/client.js";
import { evalCases, workers } from "../db/schema.js";
import { charge, tokenCredits } from "../services/credits.js";
import { callModel, type ContentBlock } from "./model.js";

const text = (content: ContentBlock[]) => content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();

function overlapScore(answer: string, expected: string) {
  const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const exp = words(expected);
  if (!exp.size) return 1;
  const ans = words(answer);
  return [...exp].filter((w) => ans.has(w)).length / exp.size;
}

/**
 * Regression evals for a Worker (architecture §4.15): run each case through the Worker's
 * instructions (side effects disabled — no tools), then grade with an LLM judge against the
 * expected behaviour. Scores land on the eval case rows.
 */
export async function runWorkerEvals(workspaceId: string, workerId: string) {
  const [w] = await db.select().from(workers).where(eq(workers.id, workerId));
  if (!w) return;
  const cases = await db.select().from(evalCases).where(eq(evalCases.workerId, workerId));
  const system = `You are the AI Worker “${w.name}”. ${w.description}\n${w.instructions}\nThis is an evaluation run: tools are disabled. Describe exactly what you would do (which actions, which approvals) and give the reply you would send.`;
  for (const c of cases) {
    const started = Date.now();
    const out = await callModel({ tier: "act", system, messages: [{ role: "user", content: c.input }], tools: [] });
    const answer = text(out.content);
    let credits = tokenCredits(out.model, out.usage);
    let score: number;
    if (modelProvider() === "anthropic") {
      const judge = await callModel({
        tier: "fast",
        system: "You grade an AI agent's response against the expected behaviour. Reply with only a JSON object: {\"score\": number between 0 and 1, \"reason\": string}.",
        messages: [{ role: "user", content: `<input>${c.input}</input>\n<expected>${c.expected}</expected>\n<response>${answer}</response>` }],
        tools: [],
      });
      credits += tokenCredits(judge.model, judge.usage);
      const m = /\{[\s\S]*\}/.exec(text(judge.content));
      score = m ? Math.max(0, Math.min(1, Number((JSON.parse(m[0]) as { score: number }).score) || 0)) : 0;
    } else {
      score = Math.round(Math.min(1, 0.5 + overlapScore(answer, c.expected)) * 100) / 100;
    }
    await charge(workspaceId, credits, { type: "eval", id: c.id });
    await db.update(evalCases).set({ score, pass: score >= 0.7, ms: Date.now() - started, lastRunAt: new Date() }).where(eq(evalCases.id, c.id));
  }
}
