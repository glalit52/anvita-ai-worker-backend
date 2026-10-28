import { sandboxAvailable } from "../../sandbox/index.js";
import { codeTool } from "./code.js";
import { customApiToolsFor } from "./custom-api.js";
import { HANDOFF_TOOL } from "./handoff.js";
import { TOOLS } from "./index.js";
import { mcpToolsFor } from "./mcp.js";
import type { ToolDef } from "./types.js";

export interface Registry {
  tools: ToolDef[];
  byName: Map<string, ToolDef>;
  /** Look up by dotted action (`hubspot.deals.search`) or model-facing name (`hubspot_deals_search`). */
  find: (actionOrName: string) => ToolDef | undefined;
}

/** Every tool a workspace can use: built-ins, app tools, MCP servers, imported APIs and the sandbox. */
export async function workspaceRegistry(workspaceId: string, opts: { includeHandoff?: boolean } = {}): Promise<Registry> {
  const tools: ToolDef[] = [...TOOLS, ...(await mcpToolsFor(workspaceId)), ...(await customApiToolsFor(workspaceId)), ...(opts.includeHandoff ? [HANDOFF_TOOL] : [])];
  const reg = build(tools);
  if (sandboxAvailable()) {
    const code = codeTool(async (a) => reg.find(a));
    reg.tools.push(code);
    reg.byName.set(code.name, code);
  }
  return reg;
}

function build(tools: ToolDef[]): Registry {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const byAction = new Map(tools.map((t) => [t.action.toLowerCase(), t]));
  return {
    tools,
    byName,
    find: (a) => {
      const key = a.trim();
      return byName.get(key) ?? byAction.get(key.toLowerCase()) ?? byName.get(key.replace(/\./g, "_")) ?? byAction.get(key.toLowerCase().replace(/_/g, "."));
    },
  };
}
