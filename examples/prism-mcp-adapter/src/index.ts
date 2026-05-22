#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createPrismMcpAdapter } from "./adapter.js";
import { readAdapterConfig } from "./config.js";
import { createPrismMcpServer } from "./mcp-server.js";
import { redactSecrets } from "./redaction.js";

async function main(): Promise<void> {
  const adapter = createPrismMcpAdapter({ config: readAdapterConfig(process.env) });
  await adapter.initialize();
  const server = createPrismMcpServer(adapter);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`Prism MCP adapter failed to start: ${redactSecrets(error)}\n`);
  process.exitCode = 1;
});
