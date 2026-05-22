import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
      client
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

    const response = await forwardSlackMethod({
      request: new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json"
      }),
      method: "chat.postMessage",
      identity,
      requestId: "req_bad_json",
      client
    });

    expect(client.callMethod).not.toHaveBeenCalled();
    expect(response.headers.get("x-prism-upstream-called")).toBe("false");
    expect(await response.json()).toEqual({ ok: false, error: "invalid_json" });
  });

  it("runs the rate-limit seam before upstream calls", async () => {
    const client: SlackWebApiClient = { callMethod: vi.fn() };
    const rateLimiter = vi.fn(() => ({ kind: "limited" as const, httpStatus: 429, body: { ok: false as const, error: "rate_limited" as const } }));

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
    expect(response.headers.get("x-prism-upstream-called")).toBe("false");
    expect(await response.json()).toEqual({ ok: false, error: "rate_limited" });
  });
});
