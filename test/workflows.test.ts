import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceRegistry } from "../src/runtime/tools/registry.js";
import { evaluate, render, test as testExpr } from "../src/workflow/expr.js";
import { WORKFLOW_TEMPLATES } from "../src/workflow/templates.js";
import { validateWorkflow } from "../src/workflow/validate.js";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => ctx.app.close());

type Api = ReturnType<typeof client>;
const n = (id: string, kind: string, title: string, config: Record<string, unknown> = {}, appId?: string) => ({ id, kind, title, x: 0, y: 0, config, ...(appId ? { appId } : {}) });
const e = (source: string, target: string, label?: string) => ({ id: `${source}-${target}`, source, target, ...(label ? { label } : {}) });

async function worker(api: Api, nodes: unknown[], edges: unknown[], extra: Record<string, unknown> = {}) {
  const w = await api.post("/v1/workers", { from: "blank", name: `WF ${Math.random().toString(36).slice(2, 6)}`, interaction: "api", nodes, edges, ...extra });
  expect(w.status).toBe(201);
  const pub = await api.post(`/v1/workers/${w.body.id}/publish`, {});
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return w.body;
}

async function run(api: Api, workerId: string, inputs: Record<string, unknown> = {}) {
  const r = await api.post(`/v1/workers/${workerId}/runs`, { inputs });
  expect(r.status).toBe(202);
  await ctx.runner.drain();
  return (await api.get(`/v1/runs/${r.body.id}`)).body;
}

describe("expressions", () => {
  it("evaluates conditions and templates safely", () => {
    const scope = { steps: { a1: { rows: [{ v: 2 }, { v: 3 }], name: "Kesar" } }, trigger: { amount: "₹6,200" } };
    expect(testExpr("trigger.amount > 5000 and steps.a1.name = kesar", scope)).toBe(true);
    expect(testExpr("confidence ≥ 95%", {}, { confidence: 0.97 })).toBe(true);
    expect(testExpr("confidence ≥ 95%", {}, { confidence: 90 })).toBe(false);
    expect(evaluate("sum(steps.a1.rows, 'v') * 2", scope)).toBe(10);
    expect(render({ to: ["{{ steps.a1.name }}"], n: "{{ len(steps.a1.rows) }}", s: "Hi {{ steps.a1.name }}!" }, scope)).toEqual({ to: ["Kesar"], n: 2, s: "Hi Kesar!" });
    expect(evaluate("x.constructor", { x: {} })).toBeUndefined();
    expect(() => evaluate("process.exit()", {})).toThrow(/built-in functions/);
  });
});

describe("workflow engine", () => {
  it("routes branches, joins paths, maps data and records a trace", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.post("/v1/connections", { appId: "shopify" });
    const w = await worker(
      api,
      [
        n("t1", "trigger", "API call"),
        n("o1", "tool", "Get order", { action: "shopify.orders.get", order: "{{ trigger.order }}" }, "shopify"),
        n("b1", "branch", "Big order?", { rules: ["big: trigger.amount > 5000", "else"] }),
        n("a1", "agent", "Classify", { model: "Fast (Haiku)", instructions: "Classify the customer message.", output: '{"intent": "order_status | return_refund | other", "sentiment": "positive | neutral | negative"}' }),
        n("a2", "agent", "Small path", { model: "Fast (Haiku)", instructions: "Say thanks." }),
        n("end", "end", "Done", { outcome: "{{ steps.o1.order }}: {{ intent }}" }),
      ],
      [e("t1", "o1"), e("o1", "b1"), e("b1", "a1", "big"), e("b1", "a2", "else"), e("a1", "end"), e("a2", "end")],
    );
    const done = await run(api, w.id, { order: "#1042", amount: 9000, text: "Where is my order?" });
    expect(done.status).toBe("succeeded");
    expect(done.output).toBe("#1042: order_status");
    const byId = Object.fromEntries(done.trace.nodes.map((x: any) => [x.id, x]));
    expect(byId.a1.status).toBe("done");
    expect(byId.a2.status).toBe("skipped");
    expect(byId.a1.output).toMatchObject({ intent: "order_status" });
    expect(done.trace.edges.find((x: any) => x.id === "b1-a1").taken).toBe(true);
    expect(done.trace.edges.find((x: any) => x.id === "b1-a2").taken).toBe(false);
    expect((await api.get(`/v1/runs/${done.id}/trace`)).body.nodes).toHaveLength(6);
  });

  it("pauses on approval steps and follows approved / rejected paths", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const w = await worker(
      api,
      [n("t1", "trigger", "API call"), n("ap1", "approval", "Manager OK?", { condition: "trigger.amount > 1000", approvers: "Role: Admin", preview: { Amount: "{{ trigger.amount }}" } }), n("yes", "end", "Approved", { outcome: "approved" }), n("no", "end", "Rejected", { outcome: "rejected" })],
      [e("t1", "ap1"), e("ap1", "yes", "approved"), e("ap1", "no", "rejected")],
    );
    // Below the threshold the approval is skipped automatically.
    expect((await run(api, w.id, { amount: 10 })).output).toBe("approved");

    const waiting = await run(api, w.id, { amount: 5000 });
    expect(waiting.status).toBe("waiting_approval");
    const [appr] = (await api.get("/v1/approvals?status=pending")).body.data;
    expect(appr).toMatchObject({ title: "Manager OK?", preview: { kind: "fields", changes: [{ field: "Amount", to: "5000" }] } });
    await api.post(`/v1/approvals/${appr.id}/decision`, { decision: "rejected" });
    await ctx.runner.drain();
    const done = (await api.get(`/v1/runs/${waiting.id}`)).body;
    expect(done).toMatchObject({ status: "succeeded", output: "rejected" });
  });

  it("runs code in the sandbox with tools, files and policy limits", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.post("/v1/connections", { appId: "hubspot" });
    await api.post("/v1/connections", { appId: "gmail" });
    const code = `deals = tools.hubspot.deals.search(range="last_30d")
files.csv("deals.csv", deals["deals"])
try:
    tools.gmail.send(to=["x@outside.com"], subject="hi", body="b")
    blocked = False
except ToolError as e:
    blocked = "approval" in str(e)
return {"total": deals["total"], "n": len(deals["deals"]), "blocked": blocked, "doubled": inputs["trigger"]["x"] * 2}`;
    const w = await worker(api, [n("t1", "trigger", "API call"), n("c1", "code", "Crunch", { language: "python", code }), n("end", "end", "Done", { outcome: "{{ steps.c1 }}" })], [e("t1", "c1"), e("c1", "end")]);
    const done = await run(api, w.id, { x: 21 });
    expect(done.status, done.error).toBe("succeeded");
    expect(done.output).toMatchObject({ n: 6, blocked: true, doubled: 42 });
    expect(done.output.files).toHaveLength(1);
    const art = (await api.get(`/v1/artifacts/${done.output.files[0]}`)).body;
    expect(art).toMatchObject({ title: "deals.csv", kind: "sheet" });
    expect(done.stepLog.some((x: any) => x.name === "hubspot.deals.search" && x.status === "done")).toBe(true);
  });

  it("fails clearly when code errors", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const w = await worker(api, [n("t1", "trigger", "API call"), n("c1", "code", "Boom", { language: "python", code: "x = 1\nraise ValueError('bad data')" })], [e("t1", "c1")]);
    const done = await run(api, w.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/Boom: ValueError: bad data \(line 2\)/);
  });

  it("loops over items and calls other Workers", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    await api.post("/v1/connections", { appId: "slack" });
    const child = await worker(api, [n("t1", "trigger", "Called"), n("end", "end", "Done", { outcome: "{{ upper(trigger.name) }}" })], [e("t1", "end")]);
    const parent = await worker(
      api,
      [
        n("t1", "trigger", "API call"),
        n("m1", "map", "Post each", { items: "{{ trigger.people }}", mode: "tool", action: "slack.post_message", "input.channel": "#team", "input.text": "Hi {{ item }} ({{ index }})" }),
        n("cw", "call_worker", "Shout", { workerId: child.id, inputs: { name: "{{ first(trigger.people) }}" } }),
        n("end", "end", "Done", { outcome: "{{ steps.m1.count }} posts; child said {{ steps.cw }}" }),
      ],
      [e("t1", "m1"), e("t1", "cw"), e("m1", "end"), e("cw", "end")],
    );
    const done = await run(api, parent.id, { people: ["asha", "ravi", "meera"] });
    expect(done.status, done.error).toBe("succeeded");
    expect(done.output).toBe("3 posts; child said ASHA");
    const childRuns = (await api.get(`/v1/workers/${child.id}/runs`)).body.data;
    expect(childRuns).toHaveLength(1);
  });

  it("waits for a missing connection and resumes once connected", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const w = await worker(api, [n("t1", "trigger", "API call"), n("z1", "tool", "Tickets", { action: "zendesk.tickets.search", query: "status:open" }, "zendesk"), n("end", "end", "Done", { outcome: "{{ steps.z1.open }}" })], [e("t1", "z1"), e("z1", "end")]);
    const waiting = await run(api, w.id);
    expect(waiting.status).toBe("waiting_auth");
    expect(waiting.trace.nodes.find((x: any) => x.id === "z1")).toMatchObject({ status: "waiting", waitingFor: "auth" });
    await api.post("/v1/connections", { appId: "zendesk" });
    await ctx.runner.drain();
    const done = (await api.get(`/v1/runs/${waiting.id}`)).body;
    expect(done.status).toBe("succeeded");
    expect(typeof done.output).toBe("number");
  });

  it("validates graphs and blocks publishing broken ones", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const w = await api.post("/v1/workers", { from: "blank", name: "Broken", interaction: "api", nodes: [n("t1", "trigger", "Go"), n("x", "tool", "Nope", { action: "made.up" }), n("b", "branch", "Bad rule", { rules: ["amount >> 3", "else"] }), n("c", "send", "Ping", { channel: "slack", message: "{{ steps. }}" })], edges: [e("t1", "x"), e("x", "b"), e("b", "c", "else"), e("c", "x")] });
    const v = (await api.post(`/v1/workers/${w.body.id}/validate`, {})).body;
    expect(v.ok).toBe(false);
    const msgs = v.issues.filter((i: any) => i.level === "error").map((i: any) => i.message).join("\n");
    expect(msgs).toMatch(/loop/);
    expect(msgs).toMatch(/Unknown action “made.up”/);
    expect(msgs).toMatch(/Rule “amount >> 3”/);
    expect(msgs).toMatch(/Message: \{\{ steps\. \}\}/);
    const pub = await api.post(`/v1/workers/${w.body.id}/publish`, {});
    expect(pub.status).toBe(422);
    expect(pub.body.error.details.issues.length).toBeGreaterThan(0);
  });

  it("ships templates whose graphs validate", async () => {
    const s = await signup(ctx.app);
    const registry = await workspaceRegistry(s.workspaceId);
    for (const t of WORKFLOW_TEMPLATES) {
      const errors = validateWorkflow({ nodes: t.nodes as any, edges: t.edges }, { registry }).filter((i) => i.level === "error");
      expect(errors, t.meta.id).toEqual([]);
    }
    const api = client(ctx.app, s);
    expect((await api.get("/v1/templates")).body.data.length).toBe(WORKFLOW_TEMPLATES.length);
  });

  it("runs the stock alert template end to end with real code", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    for (const appId of ["shopify", "slack"]) await api.post("/v1/connections", { appId });
    const w = await api.post("/v1/workers", { from: "template", templateId: "tpl-stock" });
    await api.post(`/v1/workers/${w.body.id}/publish`, {});
    const done = await run(api, w.body.id, { threshold: 100 });
    expect(done.status, done.error).toBe("succeeded");
    const byId = Object.fromEntries(done.trace.nodes.map((x: any) => [x.id, x]));
    expect(byId.c1.output).toMatchObject({ skus: 4 });
    expect(byId.s1.status).toBe("done");
  });

  it("exposes a catalog for the Studio", async () => {
    const s = await signup(ctx.app);
    const cat = (await client(ctx.app, s).get("/v1/workflow/catalog")).body;
    expect(cat.actions.find((a: any) => a.action === "tally.vouchers.create")).toMatchObject({ appId: "tally", sideEffect: "write" });
    expect(cat.functions).toContain("sum");
    expect(cat.sandbox).toBe(true);
  });
});

describe("custom APIs (OpenAPI import)", () => {
  let original: Dispatcher;
  beforeAll(() => (original = getGlobalDispatcher()));
  afterAll(() => setGlobalDispatcher(original));

  it("imports a spec and calls its operations from workflows with the API's auth", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const spec = `openapi: 3.0.0
info: { title: Kesar ERP }
servers: [{ url: "https://erp.kesar.example/api" }]
components:
  securitySchemes: { key: { type: apiKey, in: header, name: X-ERP-Key } }
  schemas: { Stock: { type: object, properties: { sku: { type: string }, qty: { type: integer } } } }
paths:
  /stock/{sku}:
    get:
      operationId: getStock
      summary: Stock for one SKU
      parameters: [{ name: sku, in: path, required: true, schema: { type: string } }, { name: warehouse, in: query, schema: { type: string } }]
  /orders:
    post:
      operationId: createOrder
      summary: Create a purchase order
      requestBody: { content: { application/json: { schema: { $ref: "#/components/schemas/Stock" } } } }
`;
    const imp = await api.post("/v1/custom-apis", { spec, secret: "erp-secret" });
    expect(imp.status).toBe(201);
    expect(imp.body).toMatchObject({ name: "Kesar ERP", slug: "kesar_erp", authType: "header", authName: "X-ERP-Key", hasSecret: true });
    expect(imp.body.operations.map((o: any) => [o.action, o.sideEffect])).toEqual([["api.kesar_erp.getstock", "none"], ["api.kesar_erp.createorder", "write"]]);

    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.enableNetConnect(/127\.0\.0\.1|localhost/);
    setGlobalDispatcher(mock);
    let key = "";
    mock
      .get("https://erp.kesar.example")
      .intercept({ path: "/api/stock/KF-1?warehouse=Pune", method: "GET" })
      .reply((o) => ((key = String((o.headers as Record<string, string>)["X-ERP-Key"] ?? (o.headers as Record<string, string>)["x-erp-key"])), { statusCode: 200, data: JSON.stringify({ sku: "KF-1", qty: 7 }), responseOptions: { headers: { "content-type": "application/json" } } }));

    const w = await worker(api, [n("t1", "trigger", "Go"), n("s1", "tool", "Stock", { action: "api.kesar_erp.getstock", sku: "{{ trigger.sku }}", warehouse: "Pune" }), n("end", "end", "Done", { outcome: "{{ steps.s1.qty }}" })], [e("t1", "s1"), e("s1", "end")]);
    const done = await run(api, w.id, { sku: "KF-1" });
    setGlobalDispatcher(original);
    expect(done.status, done.error).toBe("succeeded");
    expect(done.output).toBe(7);
    expect(key).toBe("erp-secret");
    expect((await api.get("/v1/custom-apis")).body.data).toHaveLength(1);
  });
});
