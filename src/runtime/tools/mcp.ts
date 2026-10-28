import { and, eq } from "drizzle-orm";
import { callMcpTool } from "../../connectors/mcp.js";
import { db } from "../../db/client.js";
import { mcpServers } from "../../db/schema.js";
import { decrypt } from "../../lib/crypto.js";
import type { SideEffect, ToolDef } from "./types.js";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 20) || "server";

/**
 * Tools from the workspace's MCP servers, exposed to the agent as `mcp_<server>_<tool>`.
 * Side effects come from the tool's annotations (readOnlyHint / destructiveHint); anything
 * unannotated is treated as a write, so workspace policies still apply.
 */
export async function mcpToolsFor(workspaceId: string): Promise<ToolDef[]> {
  const servers = await db.select().from(mcpServers).where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.enabled, true), eq(mcpServers.status, "healthy")));
  const out: ToolDef[] = [];
  for (const srv of servers) {
    const prefix = `mcp_${slug(srv.name)}_`;
    for (const t of srv.toolDefs) {
      const name = `${prefix}${t.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
      const ann = (t.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
      const sideEffect: SideEffect = ann.readOnlyHint ? "none" : ann.destructiveHint ? "destructive" : "write";
      const schema = (t.inputSchema ?? { type: "object" }) as ToolDef["inputSchema"];
      out.push({
        name,
        action: `mcp.${slug(srv.name)}.${t.name}`,
        appId: "mcp",
        kind: "tool",
        description: `[${srv.name} via MCP] ${t.description ?? t.name}`.slice(0, 1024),
        inputSchema: { ...schema, type: "object", properties: schema.properties ?? {} },
        sideEffect,
        needsConnection: false,
        label: () => `${ann.title ?? t.name} (${srv.name})`,
        execute: async (input) => {
          const token = srv.tokenEnc ? decrypt(srv.tokenEnc) : null;
          const r = await callMcpTool(srv.url, token, t.name, input);
          return { output: r.structured ?? { text: r.text }, summary: r.text.split("\n")[0]?.slice(0, 80) || "Done", credits: 2 };
        },
      });
    }
  }
  return out;
}
