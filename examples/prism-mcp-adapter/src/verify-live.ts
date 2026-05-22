#!/usr/bin/env node
import { createPrismMcpAdapter } from "./adapter.js";
import { readAdapterConfig } from "./config.js";
import { redactSecrets } from "./redaction.js";

async function main(): Promise<void> {
  const adapter = createPrismMcpAdapter({ config: readAdapterConfig(process.env) });
  await adapter.initialize();
  const tools = adapter.listTools();
  const readTool = tools.find((tool) => tool.name === "slack_list_channels") ?? tools.find((tool) => tool.name === "slack_channel_history") ?? tools.find((tool) => tool.name === "slack_search_messages");
  const result = readTool ? await adapter.callTool(readTool.name, verificationInput(readTool.name)) : null;

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        tools: tools.map((tool) => tool.name),
        verifiedTool: readTool?.name ?? null,
        requestId: result?.structuredContent.prism.requestId ?? null,
        upstreamCalled: result?.structuredContent.prism.upstreamCalled ?? null
      },
      null,
      2
    ) + "\n"
  );
}

function verificationInput(name: string): Record<string, unknown> {
  if (name === "slack_list_channels") return { surface: "public_channel" };
  if (name === "slack_channel_history") return { channel: "C-MOCK-GENERAL", surface: "public_channel" };
  if (name === "slack_search_messages") return { query: "mock" };
  return {};
}

main().catch((error) => {
  process.stderr.write(`Prism MCP adapter verification failed: ${redactSecrets(error)}\n`);
  process.exitCode = 1;
});
