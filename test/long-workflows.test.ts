import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { jobs, runs } from "../src/db/schema.js";
import { nextLocalTime, parseWaitDuration, waitTarget } from "../src/workflow/time.js";
import { validateWorkflow } from "../src/workflow/validate.js";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => ctx.app.close());

type Api = ReturnType<typeof client>;
const n = (id: string, kind: string, title: string, config: Record<string, unknown> = {}) => ({ id, kind, title, x: 0, y: 0, config });
const e = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });

async function worker(api: Api, nodes: unknown[], edges: unknown[]) {
  const w = await api.post("/v1/workers", { from: "blank", name: `Long ${Math.random().toString(36).slice(2, 6)}`, interaction: "api", nodes, edges });
  expect(w.status).toBe(201);
  const pub = await api.post(`/v1/workers/${w.body.id}/publish`, {});
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return w.body;
}
async function start(api: Api, workerId: string) {
  const r = await api.post(`/v1/workers/${workerId}/runs`, { inputs: {} });
  expect(r.status).toBe(202);
  await ctx.runner.drain();
  return r.body.id as string;
}
const get = async (api: Api, id: string) => (await api.get(`/v1/runs/${id}`)).body;

/** Pretend the wait is over: move the step's wake-up time and its job into the past. */
async function fastForward(runId: string, nodeId: string) {
  const [r] = await db.select().from(runs).where(eq(runs.id, runId));
  const state = r.state as { nodes: Record<string, { wakeAt?: string }> };
  state.nodes[nodeId].wakeAt = new Date(Date.now() - 1000).toISOString();
  await db.update(runs).set({ state: state as unknown as Record<string, unknown> }).where(eq(runs.id, runId));
  await db.update(jobs).set({ runAt: new Date() }).where(and(eq(jobs.status, "queued"), like(jobs.dedupeKey, `wake:${runId}:%`)));
}

describe("time helpers", () => {
  it("parses durations and finds the next local time of day", () => {
    expect(parseWaitDuration("90m")).toBe(90 * 60_000);
    expect(parseWaitDuration("2 hours")).toBe(2 * 3_600_000);
    expect(parseWaitDuration("3 days")).toBe(3 * 86_400_000);
    expect(parseWaitDuration(15)).toBe(15 * 60_000);
    expect(parseWaitDuration("soon")).toBeNull();
    // 10:00 IST on a Friday → next 09:30 IST is Saturday 04:00 UTC; with weekdays only, Monday.
    const fri = new Date("2026-11-13T04:30:00Z");
    expect(nextLocalTime("09:30", "Asia/Kolkata", fri).toISOString()).toBe("2026-11-14T04:00:00.000Z");
    expect(nextLocalTime("09:30", "Asia/Kolkata", fri, true).toISOString()).toBe("2026-11-16T04:00:00.000Z");
    expect(() => waitTarget({ duration: "200 days" }, undefined)).toThrow(/90 days/);
    expect(waitTarget({}, "2026-12-01T10:00:00Z", fri).toISOString()).toBe("2026-12-01T10:00:00.000Z");
  });

  it("validates Wait steps in the builder", () => {
    const graph = (cfg: Record<string, unknown>) => ({ nodes: [n("t1", "trigger", "Start"), n("w1", "wait", "Pause", cfg), n("end", "end", "Done")], edges: [e("t1", "w1"), e("w1", "end")] });
    const errors = (cfg: Record<string, unknown>) => validateWorkflow(graph(cfg) as never, {}).filter((i: { level: string }) => i.level === "error").map((i: { message: string }) => i.message);
    expect(errors({})[0]).toMatch(/how long/);
    expect(errors({ duration: "soon" })[0]).toMatch(/isn't a duration/);
    expect(errors({ at: "9am" })[0]).toMatch(/HH:MM/);
    expect(errors({ duration: "2h" })).toEqual([]);
  });
});

describe("long-running workflows", () => {
  it("parks on a Wait step, schedules its own wake-up, then resumes", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const w = await worker(api, [n("t1", "trigger", "Start"), n("w1", "wait", "Wait 2 hours", { duration: "2h" }), n("end", "end", "Done", { outcome: "{{ steps.w1.waitedUntil }}" })], [e("t1", "w1"), e("w1", "end")]);
    const id = await start(api, w.id);
    const parked = await get(api, id);
    expect(parked.status).toBe("waiting");
    const wait = parked.trace.nodes.find((x: { id: string }) => x.id === "w1");
    expect(wait).toMatchObject({ status: "waiting", waitingFor: "timer" });
    expect(wait.detail).toMatch(/Waiting until/);
    const [job] = await db.select().from(jobs).where(and(eq(jobs.status, "queued"), like(jobs.dedupeKey, `wake:${id}:%`)));
    expect(job.runAt.getTime() - Date.now()).toBeGreaterThan(110 * 60_000);

    // Nothing happens before the wake-up time…
    await ctx.runner.drain();
    expect((await get(api, id)).status).toBe("waiting");
    // …and the run finishes once it's due.
    await fastForward(id, "w1");
    await ctx.runner.drain();
    const done = await get(api, id);
    expect(done.status, done.error).toBe("succeeded");
    expect(typeof done.output).toBe("string");
  });

  it("fails runs that outlive their calendar limit", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const w = await worker(api, [n("t1", "trigger", "Start", { maxDays: 2 }), n("w1", "wait", "Wait", { duration: "1d" }), n("end", "end", "Done")], [e("t1", "w1"), e("w1", "end")]);
    const id = await start(api, w.id);
    await db.update(runs).set({ startedAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(runs.id, id));
    await fastForward(id, "w1");
    await ctx.runner.drain();
    const r = await get(api, id);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/after 2 days/);
  });

  it("hands long runs back to the queue in chunks and still completes", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const slow = (id: string) => n(id, "code", `Slow ${id}`, { language: "python", code: "import time\ntime.sleep(0.7)\nreturn {'ok': True}" });
    const w = await worker(api, [n("t1", "trigger", "Start"), slow("c1"), slow("c2"), slow("c3"), n("end", "end", "Done", { outcome: "finished" })], [e("t1", "c1"), e("c1", "c2"), e("c2", "c3"), e("c3", "end")]);
    const id = await start(api, w.id);
    const r = await get(api, id);
    expect(r.status, r.error).toBe("succeeded");
    expect(r.output).toBe("finished");
    const [{ n: advances }] = (await db.execute(sql`select count(*)::int as n from jobs where type = 'run.advance' and payload->>'runId' = ${id}`)) as unknown as { n: number }[];
    expect(advances).toBeGreaterThanOrEqual(2);
  });
});
