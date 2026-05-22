import { createPrismClient, type PrismClient } from "./prism-client.js";
import { toolMappings } from "./tool-mappings.js";
import type { AdapterConfig, AdapterToolDefinition, AdapterToolResult, PrismCapabilitiesBody } from "./types.js";

export type PrismMcpAdapter = {
  initialize(): Promise<void>;
  listTools(): AdapterToolDefinition[];
  callTool(name: string, input: Record<string, unknown>): Promise<AdapterToolResult>;
};

export function createPrismMcpAdapter({ config, fetch, client = createPrismClient({ config, fetch }) }: { config: AdapterConfig; fetch?: typeof globalThis.fetch; client?: PrismClient }): PrismMcpAdapter {
  let capabilities: PrismCapabilitiesBody | null = null;

  return {
    async initialize() {
      const status = await client.status();
      if (status.token.status !== "active") throw new Error(`${status.token.status}_prism_developer_token`);
      if (status.slack?.reauthRequired || status.slack?.status === "reauth_required") throw new Error("slack_reauth_required");
      capabilities = await client.capabilities();
    },
    listTools() {
      return toolMappings.filter((tool) => isAllowed(capabilities, tool.method)).map(({ name, description, method }) => ({ name, description, method }));
    },
    async callTool(name, input) {
      const tool = toolMappings.find((mapping) => mapping.name === name);
      if (!tool) return adapterError(name, "unknown_tool", null);

      capabilities = await client.capabilities();
      if (!isAllowed(capabilities, tool.method)) return adapterError(tool.method, denialReason(capabilities, tool.method), capabilities.requestId);

      const headers: Record<string, string> = {};
      if (tool.requiresSurface && typeof input.surface === "string") headers["x-prism-surface"] = input.surface;
      if (typeof input.workspaceId === "string") headers["x-prism-workspace-id"] = input.workspaceId;
      if (typeof input.executionMode === "string") headers["x-prism-execution-mode"] = input.executionMode;

      const response = await client.callSlackMethod({
        method: tool.method,
        httpMethod: tool.httpMethod,
        payload: tool.payload(input),
        headers
      });
      const slackOk = isRecord(response.body) && response.body.ok !== false;
      return {
        isError: !slackOk || response.status >= 400,
        content: [{ type: "text", text: JSON.stringify(response.body) }],
        structuredContent: {
          method: tool.method,
          ok: slackOk && response.status < 400,
          prism: {
            requestId: response.headers["x-prism-request-id"] ?? null,
            upstreamCalled: readBooleanHeader(response.headers["x-prism-upstream-called"]),
            retryAfter: response.headers["retry-after"],
            slackRequestId: response.headers["x-slack-req-id"]
          },
          slack: response.body,
          error: slackError(response.body)
        }
      };
    }
  };
}

function isAllowed(capabilities: PrismCapabilitiesBody | null, method: string): boolean {
  return capabilities?.token.status === "active" && capabilities.slack?.reauthRequired !== true && capabilities.methods?.[method]?.status === "allowed";
}

function denialReason(capabilities: PrismCapabilitiesBody, method: string): string {
  if (capabilities.slack?.reauthRequired) return "reauth_required";
  return capabilities.methods?.[method]?.status ?? "unsupported";
}

function adapterError(method: string, error: string, requestId: string | null): AdapterToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error }],
    structuredContent: {
      method,
      ok: false,
      prism: { requestId, upstreamCalled: false },
      error
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slackError(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string" ? value.error : undefined;
}

function readBooleanHeader(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}
