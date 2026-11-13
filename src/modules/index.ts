import type { FastifyPluginAsync } from "fastify";
import { approvalLinkRoutes, approvalRoutes } from "./approvals.js";
import { authRoutes } from "./auth.js";
import { chatRoutes } from "./chat.js";
import { governanceRoutes } from "./governance.js";
import { integrationRoutes } from "./integrations.js";
import { knowledgeRoutes } from "./knowledge.js";
import { opsRoutes } from "./ops.js";
import { workerHookRoutes, workerRoutes } from "./workers.js";
import { workspaceRoutes } from "./workspace.js";
import { channelRoutes } from "./channels.js";
import { billingHookRoutes } from "./billing-hooks.js";
import { customApiRoutes } from "./custom-apis.js";
import { enterpriseRoutes } from "./enterprise.js";
import { channelEndpointRoutes, channelPublicRoutes } from "./channel-endpoints.js";
import { publicApiRoutes } from "./public-api.js";

export const registerRoutes: FastifyPluginAsync = async (app) => {
  for (const r of [authRoutes, workspaceRoutes, chatRoutes, approvalRoutes, integrationRoutes, customApiRoutes, workerRoutes, knowledgeRoutes, governanceRoutes, opsRoutes, channelEndpointRoutes, publicApiRoutes]) await app.register(r);
  await app.register(workerHookRoutes);
  await app.register(channelRoutes);
  await app.register(billingHookRoutes);
  await app.register(enterpriseRoutes);
  await app.register(approvalLinkRoutes);
  await app.register(channelPublicRoutes);
};
