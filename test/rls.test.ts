import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, tenantIsolationActive, withTenant } from "../src/db/client.js";
import { threads, workspaces } from "../src/db/schema.js";
import { client, setup, signup, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => ctx.app.close());

describe("row-level security", () => {
  it("is active and covers every workspace-scoped table", async () => {
    expect(tenantIsolationActive()).toBe(true);
    const rows = (await db.execute(sql`
      select c.table_name, cl.relrowsecurity as rls, exists (select 1 from pg_policies p where p.tablename = c.table_name and p.policyname = 'tenant_isolation') as policy
      from information_schema.columns c join pg_class cl on cl.relname = c.table_name and cl.relkind = 'r'
      where c.table_schema = 'public' and c.column_name = 'workspace_id'`)) as unknown as { table_name: string; rls: boolean; policy: boolean }[];
    expect(rows.length).toBeGreaterThan(25);
    expect(rows.filter((r) => !r.rls || !r.policy).map((r) => r.table_name)).toEqual([]);
  });

  it("hides other workspaces' rows even from unfiltered queries", async () => {
    const a = await signup(ctx.app);
    const b = await signup(ctx.app);
    await client(ctx.app, a).post("/v1/threads", { title: "A's secret" });
    await client(ctx.app, b).post("/v1/threads", { title: "B's secret" });

    const seen = await withTenant(a.workspaceId, async () => ({
      threads: (await db.select({ title: threads.title, ws: threads.workspaceId }).from(threads)).map((t) => t.ws),
      workspaces: (await db.select({ id: workspaces.id }).from(workspaces)).map((w) => w.id),
      users: ((await db.execute(sql`select count(*)::int as n from users`)) as unknown as { n: number }[])[0].n,
    }));
    expect(new Set(seen.threads)).toEqual(new Set([a.workspaceId]));
    expect(seen.workspaces).toEqual([a.workspaceId]);
    expect(seen.users).toBe(1);

    // Writes into another workspace are rejected by the policy's WITH CHECK.
    const err = await withTenant(a.workspaceId, () => db.insert(threads).values({ id: `thr_x${Date.now()}`, workspaceId: b.workspaceId, title: "smuggled" })).catch((e: Error & { cause?: Error }) => e);
    expect(String((err as Error & { cause?: Error }).cause?.message ?? err)).toMatch(/row-level security/);
    // Nested transactions keep the tenant scope.
    const nested = await withTenant(a.workspaceId, () => db.transaction(async (tx) => (await tx.select({ ws: threads.workspaceId }).from(threads)).map((t) => t.ws)));
    expect(new Set(nested)).toEqual(new Set([a.workspaceId]));
  });

  it("keeps API requests consistent: responses are sent only after commit", async () => {
    const s = await signup(ctx.app);
    const api = client(ctx.app, s);
    for (let i = 0; i < 10; i++) {
      const t = await api.post("/v1/threads", { title: `t${i}` });
      expect((await api.get(`/v1/threads/${t.body.id}`)).status).toBe(200);
    }
  });
});
