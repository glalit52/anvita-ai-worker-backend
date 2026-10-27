import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../src/app.js";
import { registerJobHandlers } from "../src/jobs/handlers.js";
import { JobRunner } from "../src/jobs/queue.js";
import { randomString } from "../src/lib/ids.js";

export interface Ctx {
  app: FastifyInstance;
  runner: JobRunner;
}

export async function setup(): Promise<Ctx> {
  const app = await buildApp({ logger: false });
  await app.ready();
  registerJobHandlers();
  const runner = new JobRunner(app.log, 4);
  return { app, runner };
}

export interface Session { token: string; refreshToken: string; workspaceId: string; userId: string; email: string }

export async function signup(app: FastifyInstance, opts: { name?: string; workspaceName?: string; domain?: string } = {}): Promise<Session> {
  const email = `u${randomString(8)}@${opts.domain ?? "acme.in"}`;
  const res = await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { name: opts.name ?? "Test Owner", email, password: "correct-horse-battery", workspaceName: opts.workspaceName ?? "Acme" } });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  const b = res.json();
  return { token: b.accessToken, refreshToken: b.refreshToken, workspaceId: b.workspaceId, userId: b.user.id, email };
}

/** Authenticated request helper returning parsed JSON + status. */
export function client(app: FastifyInstance, s: { token: string; workspaceId?: string }) {
  const call = async (method: InjectOptions["method"], url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as InjectOptions["payload"], headers: { authorization: `Bearer ${s.token}`, ...(s.workspaceId ? { "x-workspace-id": s.workspaceId } : {}) } });
    let body: any = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, payload: unknown = {}) => call("POST", url, payload),
    patch: (url: string, payload: unknown) => call("PATCH", url, payload),
    put: (url: string, payload: unknown) => call("PUT", url, payload),
    del: (url: string) => call("DELETE", url),
  };
}
