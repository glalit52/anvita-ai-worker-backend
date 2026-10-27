import type { FastifyPluginAsync } from "fastify";
import { approvalRoutes } from "./approvals.js";
import { authRoutes } from "./auth.js";
import { chatRoutes } from "./chat.js";
import { governanceRoutes } from "./governance.js";
import { integrationRoutes } from "./integrations.js";
import { knowledgeRoutes } from "./knowledge.js";
import { opsRoutes } from "./ops.js";
import { workerHookRoutes, workerRoutes } from "./workers.js";
import { workspaceRoutes } from "./workspace.js";

export const registerRoutes: FastifyPluginAsync = async (app) => {
  for (const r of [authRoutes, workspaceRoutes, chatRoutes, approvalRoutes, integrationRoutes, workerRoutes, knowledgeRoutes, governanceRoutes, opsRoutes]) await app.register(r);
  await app.register(workerHookRoutes);
};
