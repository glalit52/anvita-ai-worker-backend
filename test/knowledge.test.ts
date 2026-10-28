import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { EMBED_DIM, embed } from "../src/services/embeddings.js";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => ctx.app.close());

async function upload(api: ReturnType<typeof client>, token: string, kbId: string, name: string, text: string) {
  const boundary = "----anvita";
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--${boundary}--\r\n`;
  const res = await ctx.app.inject({ method: "POST", url: `/v1/knowledge-bases/${kbId}/documents`, payload: body, headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` } });
  expect(res.statusCode).toBe(201);
}

describe("hybrid knowledge search", () => {
  it("indexes documents with embeddings and finds passages keyword search misses", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    const kb = (await api.post("/v1/knowledge-bases", { name: "Policies" })).body;
    await upload(api, s.token, kb.id, "Returns.md", "# Returns\n\nItems can be returned within 7 days of delivery if unopened. Refunds go back to the original payment method within 5 working days.");
    await upload(api, s.token, kb.id, "Shipping.md", "# Shipping\n\nWe ship across India with Delhivery. Metro deliveries take 2-3 days; other pincodes 4-7 days.");
    await ctx.runner.drain();

    const status = (await api.get("/v1/knowledge/status")).body;
    expect(status).toMatchObject({ mode: "hybrid", provider: "hash", chunks: 2, embedded: 2 });

    // Exact words: both retrievers agree.
    const exact = (await api.post("/v1/knowledge/search", { query: "refund payment method" })).body.data;
    expect(exact[0]).toMatchObject({ title: "Returns.md", match: "both" });

    // Misspelt query: no full-text match, but the vectors (character trigrams) still find it.
    const fuzzy = (await api.post("/v1/knowledge/search", { query: "refnds retruned" })).body.data;
    expect(fuzzy[0]).toMatchObject({ title: "Returns.md", match: "semantic" });

    // Workspaces never see each other's vectors.
    const other = await signup(ctx.app);
    expect((await client(ctx.app, other).post("/v1/knowledge/search", { query: "refnds retruned" })).body.data).toEqual([]);
  });

  it("calls Voyage with 1024-dimensional output", async () => {
    const original: Dispatcher = getGlobalDispatcher();
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    let body: any = null;
    mock
      .get("https://api.voyageai.com")
      .intercept({ path: "/v1/embeddings", method: "POST" })
      .reply((o) => ((body = JSON.parse(String(o.body))), { statusCode: 200, data: JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), responseOptions: { headers: { "content-type": "application/json" } } }));
    const prev = { p: config.EMBEDDINGS_PROVIDER, k: config.VOYAGE_API_KEY };
    Object.assign(config, { EMBEDDINGS_PROVIDER: "voyage", VOYAGE_API_KEY: "pa-test" });
    try {
      const out = await embed(["a", "b"], "query");
      expect(body).toMatchObject({ input: ["a", "b"], model: "voyage-3.5", input_type: "query", output_dimension: EMBED_DIM });
      expect(out).toEqual([[1, 0], [0, 1]]); // re-ordered by index
    } finally {
      Object.assign(config, { EMBEDDINGS_PROVIDER: prev.p, VOYAGE_API_KEY: prev.k });
      setGlobalDispatcher(original);
    }
  });
});
