import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createPrismMcpAdapter } from "./adapter";
import { createPrismMcpServer } from "./mcp-server";

describe("Prism MCP server", () => {
  it("registers allowed Prism-backed tools through the MCP SDK and executes them over a transport", async () => {
    const adapter = createPrismMcpAdapter({
      config: { baseUrl: "http://prism.local", developerToken: "prism_dev_mcpservercanarymcpservercanary12" },
      fetch: async (url: string | URL) => {
        const target = String(url);
        if (target.endsWith("/v1/prism/status")) {
          return jsonResponse({ requestId: "req_status", token: { valid: true, status: "active", tokenProfileId: "profile_1", expiresAt: null }, slack: { status: "healthy", reauthRequired: false } });
        }
        if (target.endsWith("/v1/prism/capabilities")) {
          return jsonResponse({
            requestId: "req_capabilities",
            token: { status: "active", tokenProfileId: "profile_1", expiresAt: null },
            slack: { status: "healthy", reauthRequired: false },
            methods: { "conversations.history": { status: "allowed", supported: true, category: "conversations.read" } }
          });
        }
        if (target.includes("/v1/slack/api/conversations.history")) {
          return jsonResponse({ ok: true, messages: [{ type: "message", channel: "C123" }] }, { "x-prism-request-id": "req_history", "x-prism-upstream-called": "true" });
        }
        throw new Error(`unexpected request ${url}`);
      }
    });
    await adapter.initialize();
    const server = createPrismMcpServer(adapter);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    const result = await client.callTool({ name: "slack_channel_history", arguments: { channel: "C123", surface: "public_channel" } });
    await Promise.all([client.close(), server.close()]);

    expect(tools.tools.map((tool) => tool.name)).toEqual(["slack_channel_history"]);
    expect(tools.tools[0]?.inputSchema).toMatchObject({
      properties: { channel: expect.any(Object), surface: expect.any(Object) },
      required: ["channel", "surface"]
    });
    expect(result).toMatchObject({
      isError: false,
      structuredContent: { method: "conversations.history", ok: true, prism: { requestId: "req_history", upstreamCalled: true } }
    });
  });
});

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: headers["status"] ? Number(headers["status"]) : 200,
    headers: { "content-type": "application/json", "x-prism-request-id": "req_default", "x-prism-upstream-called": "false", ...headers }
  });
}
