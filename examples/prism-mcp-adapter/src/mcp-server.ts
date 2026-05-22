import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { PrismMcpAdapter } from "./adapter.js";
import { toolMappings } from "./tool-mappings.js";

export function createPrismMcpServer(adapter: PrismMcpAdapter): McpServer {
  const server = new McpServer({ name: "prism-reference-mcp-adapter", version: "0.1.0" });
  for (const tool of adapter.listTools()) {
    const mapping = toolMappings.find((candidate) => candidate.name === tool.name);
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: mapping?.inputSchema
      },
      async (input) => {
        const result = await adapter.callTool(tool.name, input as Record<string, unknown>);
        return {
          content: result.content ?? [{ type: "text", text: JSON.stringify(result.structuredContent) }],
          structuredContent: result.structuredContent,
          isError: result.isError
        };
      }
    );
  }
  return server;
}
