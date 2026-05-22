import { describe, expect, it, vi } from "vitest";

import { createPrismMcpAdapter } from "./adapter";
import type { AdapterToolResult } from "./types";

const developerToken = "prism_dev_referenceadaptercanaryreferenceadapter";

describe("Prism reference MCP adapter", () => {
  it("validates Prism capabilities, exposes allowed representative tools, and calls Prism with only the Prism developer token", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/v1/prism/status")) {
        return jsonResponse({ requestId: "req_status", token: { valid: true, status: "active", tokenProfileId: "profile_1", expiresAt: null }, slack: { status: "healthy", reauthRequired: false } });
      }
      if (String(url).endsWith("/v1/prism/capabilities")) {
        return jsonResponse({
          requestId: "req_capabilities",
          token: { status: "active", tokenProfileId: "profile_1", expiresAt: null },
          slack: { status: "healthy", reauthRequired: false },
          methods: {
            "conversations.list": { status: "allowed", supported: true, category: "conversations.read" },
            "conversations.history": { status: "allowed", supported: true, category: "conversations.read" },
            "search.messages": { status: "allowed", supported: true, category: "search" },
            "chat.postMessage": { status: "denied", supported: true, category: "messages.write", requiredCapability: "writeMessages" }
          }
        });
      }
      if (String(url).includes("/v1/slack/api/conversations.history")) {
        return jsonResponse({ ok: true, messages: [{ type: "message", channel: "C123", text: "hello" }] }, { "x-prism-request-id": "req_history", "x-prism-upstream-called": "true" });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const adapter = createPrismMcpAdapter({
      config: { baseUrl: "http://prism.local/", developerToken },
      fetch
    });

    await adapter.initialize();

    expect(adapter.listTools().map((tool) => tool.name)).toEqual(["slack_list_channels", "slack_channel_history", "slack_search_messages"]);
    const result = await adapter.callTool("slack_channel_history", { channel: "C123", surface: "public_channel" });

    expect(result).toMatchObject<AdapterToolResult>({
      isError: false,
      structuredContent: {
        method: "conversations.history",
        ok: true,
        prism: { requestId: "req_history", upstreamCalled: true },
        slack: { ok: true, messages: [{ type: "message", channel: "C123", text: "hello" }] }
      }
    });
    const historyRequest = requests.find((request) => request.url.includes("/v1/slack/api/conversations.history"));
    expect(historyRequest?.url).toBe("http://prism.local/v1/slack/api/conversations.history?channel=C123");
    expect(historyRequest?.init?.headers).toMatchObject({
      authorization: `Bearer ${developerToken}`,
      "x-prism-surface": "public_channel"
    });
    expect(JSON.stringify(requests)).not.toMatch(/xox[bp]-|client_secret|refresh_token|local-tool-token/i);
  });

  it("surfaces Prism-side and upstream Slack rate limits distinctly without leaking the Prism developer token", async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      expect(JSON.stringify(init)).not.toMatch(/xox[bp]-|client_secret|refresh_token/i);
      if (target.endsWith("/v1/prism/status")) {
        return jsonResponse({ requestId: "req_status", token: { valid: true, status: "active", tokenProfileId: "profile_1", expiresAt: null }, slack: { status: "healthy", reauthRequired: false } });
      }
      if (target.endsWith("/v1/prism/capabilities")) {
        return jsonResponse({
          requestId: "req_capabilities",
          token: { status: "active", tokenProfileId: "profile_1", expiresAt: null },
          slack: { status: "healthy", reauthRequired: false },
          methods: { "conversations.history": { status: "allowed", supported: true, category: "conversations.read" }, "chat.postMessage": { status: "allowed", supported: true, category: "messages.write" } }
        });
      }
      if (target.includes("/v1/slack/api/conversations.history")) {
        return jsonResponse({ ok: false, error: "rate_limited" }, { status: "429", "retry-after": "60", "x-prism-request-id": "req_prism_limit", "x-prism-upstream-called": "false" });
      }
      if (target.includes("/v1/slack/api/chat.postMessage")) {
        return jsonResponse(
          { ok: false, error: "slack_rate_limited" },
          { status: "429", "retry-after": "30", "x-slack-req-id": "slack_req_1", "x-prism-request-id": "req_slack_limit", "x-prism-upstream-called": "true" }
        );
      }
      throw new Error(`unexpected request ${url}`);
    });
    const adapter = createPrismMcpAdapter({ config: { baseUrl: "http://prism.local", developerToken }, fetch });
    await adapter.initialize();

    const prismLimit = await adapter.callTool("slack_channel_history", { channel: "C123", surface: "public_channel" });
    const upstreamLimit = await adapter.callTool("slack_post_message", { channel: "C123", text: "MESSAGE_TEXT_CANARY", surface: "public_channel" });

    expect(prismLimit).toMatchObject({
      isError: true,
      structuredContent: { method: "conversations.history", ok: false, error: "rate_limited", prism: { requestId: "req_prism_limit", upstreamCalled: false, retryAfter: "60" } }
    });
    expect(upstreamLimit).toMatchObject({
      isError: true,
      structuredContent: {
        method: "chat.postMessage",
        ok: false,
        error: "slack_rate_limited",
        prism: { requestId: "req_slack_limit", upstreamCalled: true, retryAfter: "30", slackRequestId: "slack_req_1" }
      }
    });
    expect(JSON.stringify({ prismLimit, upstreamLimit })).not.toMatch(/prism_dev_|MESSAGE_TEXT_CANARY|xox[bp]-|client_secret|refresh_token/i);
  });

  it("fails startup before tool exposure for invalid tokens and Slack reauth-required state", async () => {
    const invalidFetch = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/v1/prism/status")) return jsonResponse({ requestId: "req_invalid", token: { valid: false, status: "invalid" } }, { status: "401" });
      throw new Error(`unexpected request ${url}`);
    });
    await expect(createPrismMcpAdapter({ config: { baseUrl: "http://prism.local", developerToken }, fetch: invalidFetch }).initialize()).rejects.toThrow(
      /invalid_prism_developer_token/
    );
    expect(invalidFetch).toHaveBeenCalledTimes(1);

    const reauthFetch = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/v1/prism/status")) {
        return jsonResponse({
          requestId: "req_reauth",
          token: { valid: true, status: "active", tokenProfileId: "profile_1", expiresAt: null },
          slack: { status: "reauth_required", reauthRequired: true }
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    await expect(createPrismMcpAdapter({ config: { baseUrl: "http://prism.local", developerToken }, fetch: reauthFetch }).initialize()).rejects.toThrow(
      /slack_reauth_required/
    );
    expect(reauthFetch).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: headers["status"] ? Number(headers["status"]) : 200,
    headers: { "content-type": "application/json", "x-prism-request-id": "req_default", "x-prism-upstream-called": "false", ...headers }
  });
}
