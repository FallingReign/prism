import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { ActivityAuditUnavailableError } from "../audit/postgres-store";
import { forwardSlackMethod } from "./forwarding";
import type { SlackWebApiClient } from "./web-api-client";
import type { SlackExecutionIdentityDecision } from "../token-profiles/execution-identity";

const identity: Extract<SlackExecutionIdentityDecision, { kind: "resolved" }> = {
  kind: "resolved",
  tokenProfileId: "profile_1",
  slackConnectionId: "conn_1",
  executionMode: "bot",
  requestedMode: null
};
const allowRateLimiter = () => ({ kind: "allowed" as const });

describe("Slack forwarding service", () => {
  it("preserves Slack-shaped JSON payloads while stripping Local-tool token fields before the upstream call", async () => {
    const calls: unknown[] = [];
    const client: SlackWebApiClient = {
      async callMethod(input) {
        calls.push(input);
        return { status: 200, body: { ok: true, channel: input.payload.channel, message: { text: input.payload.text } } };
      }
    };

    const response = await forwardSlackMethod({
      request: new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C123", text: "hello", token: "prism_dev_must_not_forward" })
      }),
      method: "chat.postMessage",
      identity,
      requestId: "req_forward_json",
      client,
      rateLimiter: allowRateLimiter
    });

    expect(calls).toEqual([
      {
        method: "chat.postMessage",
        httpMethod: "POST",
        payload: { channel: "C123", text: "hello" },
        executionMode: "bot"
      }
    ]);
    expect(response.headers.get("x-prism-upstream-called")).toBe("true");
    expect(await response.json()).toEqual({ ok: true, channel: "C123", message: { text: "hello" } });
  });

  it("rejects malformed Slack JSON payloads before upstream calls", async () => {
    const client: SlackWebApiClient = { callMethod: vi.fn() };
    const rateLimiter = vi.fn(allowRateLimiter);

    const response = await forwardSlackMethod({
      request: new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json"
      }),
      method: "chat.postMessage",
      identity,
      requestId: "req_bad_json",
      client,
      rateLimiter
    });

    expect(client.callMethod).not.toHaveBeenCalled();
    expect(rateLimiter).not.toHaveBeenCalled();
    expect(response.headers.get("x-prism-upstream-called")).toBe("false");
    expect(await response.json()).toEqual({ ok: false, error: "invalid_json" });
  });

  it("runs the rate-limit seam before upstream calls", async () => {
    const client: SlackWebApiClient = { callMethod: vi.fn() };
    const rateLimiter = vi.fn(() => ({ kind: "limited" as const, httpStatus: 429, retryAfterSeconds: 60, body: { ok: false as const, error: "rate_limited" as const } }));

    const response = await forwardSlackMethod({
      request: new NextRequest("http://localhost:3732/v1/slack/api/conversations.list?limit=2"),
      method: "conversations.list",
      identity,
      requestId: "req_limited",
      client,
      rateLimiter
    });

    expect(rateLimiter).toHaveBeenCalledWith({ tokenProfileId: "profile_1", method: "conversations.list", executionMode: "bot", requestId: "req_limited" });
    expect(client.callMethod).not.toHaveBeenCalled();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-prism-upstream-called")).toBe("false");
    expect(await response.json()).toEqual({ ok: false, error: "rate_limited" });
  });

  it("records metadata-only audit attempts and outcomes without storing request content", async () => {
    const calls: unknown[] = [];
    const client: SlackWebApiClient = {
      async callMethod(input) {
        calls.push(input);
        return { status: 200, body: { ok: true, channel: input.payload.channel, message: { text: input.payload.text } } };
      }
    };
    const audit = {
      store: {
        recordActivity: vi.fn(async (input) => ({ id: "audit_1", ...input })),
        updateActivityOutcome: vi.fn(async () => null)
      },
      base: {
        prismUserId: "user_1",
        slackConnectionId: "conn_1",
        tokenProfileId: "profile_1",
        tokenProfileName: "Local MCP",
        activityType: "slack_method" as const,
        slackMethod: "chat.postMessage",
        actionCategory: "messages.write",
        surface: "public_channel",
        executionMode: "bot",
        requestId: "req_audit"
      }
    };

    const response = await forwardSlackMethod({
      request: new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C123", text: "MESSAGE_TEXT_CANARY", blocks: [{ text: "BLOCK_KIT_CANARY" }], token: "prism_dev_must_not_audit" })
      }),
      method: "chat.postMessage",
      identity,
      requestId: "req_audit",
      client,
      rateLimiter: allowRateLimiter,
      audit
    });

    expect(response.headers.get("x-prism-upstream-called")).toBe("true");
    expect(audit.store.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ status: "attempted", objectType: "channel", objectId: "C123", upstreamCalled: false })
    );
    expect(audit.store.updateActivityOutcome).toHaveBeenCalledWith(
      "audit_1",
      expect.objectContaining({ status: "forwarded", httpStatus: 200, upstreamCalled: true })
    );
    expect(JSON.stringify(audit.store.recordActivity.mock.calls)).not.toMatch(/MESSAGE_TEXT_CANARY|BLOCK_KIT_CANARY|prism_dev_/);
    expect(calls).toHaveLength(1);
  });

  it("preserves the Slack response when the final audit outcome update fails after upstream", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client: SlackWebApiClient = {
      async callMethod(input) {
        return { status: 200, body: { ok: true, channel: input.payload.channel, message: { text: input.payload.text } } };
      }
    };
    const audit = {
      store: {
        recordActivity: vi.fn(async (input) => ({ id: "audit_1", ...input })),
        updateActivityOutcome: vi.fn(async () => {
          throw new Error("database unavailable");
        })
      },
      base: {
        prismUserId: "user_1",
        slackConnectionId: "conn_1",
        tokenProfileId: "profile_1",
        tokenProfileName: "Local MCP",
        activityType: "slack_method" as const,
        slackMethod: "chat.postMessage",
        actionCategory: "messages.write",
        surface: "public_channel",
        executionMode: "bot",
        requestId: "req_audit_update_fail"
      }
    };

    const response = await forwardSlackMethod({
      request: new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C123", text: "hello" })
      }),
      method: "chat.postMessage",
      identity,
      requestId: "req_audit_update_fail",
      client,
      rateLimiter: allowRateLimiter,
      audit
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-prism-upstream-called")).toBe("true");
    expect(await response.json()).toEqual({ ok: true, channel: "C123", message: { text: "hello" } });
    expect(errorSpy).toHaveBeenCalledWith(
      "prism_activity_audit_update_failed",
      expect.objectContaining({ requestId: "req_audit_update_fail", method: "chat.postMessage", auditId: "audit_1" })
    );
    errorSpy.mockRestore();
  });

  it("passes upstream Slack 429 responses through with retry headers and upstream diagnostics", async () => {
    const client: SlackWebApiClient = {
      async callMethod() {
        return { status: 429, body: { ok: false, error: "slack_rate_limited" }, headers: { "retry-after": "30", "x-slack-req-id": "slack_req_1" } };
      }
    };
    const audit = {
      store: {
        recordActivity: vi.fn(async (input) => ({ id: "audit_1", ...input })),
        updateActivityOutcome: vi.fn(async () => null)
      },
      base: {
        prismUserId: "user_1",
        slackConnectionId: "conn_1",
        tokenProfileId: "profile_1",
        tokenProfileName: "Local MCP",
        activityType: "slack_method" as const,
        slackMethod: "conversations.history",
        actionCategory: "conversations.read",
        surface: "public_channel",
        executionMode: "bot",
        requestId: "req_upstream_429"
      }
    };

    const response = await forwardSlackMethod({
      request: new NextRequest("http://localhost:3732/v1/slack/api/conversations.history?channel=C123"),
      method: "conversations.history",
      identity,
      requestId: "req_upstream_429",
      client,
      rateLimiter: allowRateLimiter,
      audit
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("x-slack-req-id")).toBe("slack_req_1");
    expect(response.headers.get("x-prism-upstream-called")).toBe("true");
    expect(await response.json()).toEqual({ ok: false, error: "slack_rate_limited" });
    expect(audit.store.updateActivityOutcome).toHaveBeenCalledWith(
      "audit_1",
      expect.objectContaining({ status: "upstream_error", errorClass: "slack_rate_limited", httpStatus: 429, upstreamCalled: true })
    );
  });

  it("does not call upstream when the required pre-upstream audit insert is unavailable", async () => {
    const client: SlackWebApiClient = { callMethod: vi.fn() };
    const audit = {
      store: {
        recordActivity: vi.fn(async () => {
          throw new ActivityAuditUnavailableError("record");
        }),
        updateActivityOutcome: vi.fn()
      },
      base: {
        prismUserId: "user_1",
        slackConnectionId: "conn_1",
        tokenProfileId: "profile_1",
        tokenProfileName: "Local MCP",
        activityType: "slack_method" as const,
        slackMethod: "chat.postMessage",
        actionCategory: "messages.write",
        surface: "public_channel",
        executionMode: "bot",
        requestId: "req_audit_unavailable"
      }
    };

    const response = await forwardSlackMethod({
      request: new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "C123", text: "hello" })
      }),
      method: "chat.postMessage",
      identity,
      requestId: "req_audit_unavailable",
      client,
      rateLimiter: allowRateLimiter,
      audit
    });

    expect(client.callMethod).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(response.headers.get("x-prism-upstream-called")).toBe("false");
    expect(await response.json()).toEqual({ ok: false, error: "audit_unavailable" });
  });
});
