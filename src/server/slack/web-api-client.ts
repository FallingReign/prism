import "server-only";

import { getSlackWebApiConfig, type SlackWebApiConfig } from "../config";
import type { ConcreteExecutionMode } from "../token-profiles/execution-identity";

export type SlackForwardingPayload = Record<string, unknown>;
export type SlackPayloadEncoding = "query" | "json" | "form";

export type SlackWebApiCall = {
  method: string;
  httpMethod: "GET" | "POST";
  payloadEncoding?: SlackPayloadEncoding;
  payload: SlackForwardingPayload;
  executionMode: ConcreteExecutionMode;
  accessToken?: string;
};

export type SlackWebApiResult = {
  status: number;
  body: unknown;
  headers?: Headers | Record<string, string | undefined>;
};

export type SlackWebApiClient = {
  requiresAccessToken?: boolean;
  callMethod(input: SlackWebApiCall): Promise<SlackWebApiResult>;
};

export function createDefaultSlackWebApiClient(config: SlackWebApiConfig = getSlackWebApiConfig()): SlackWebApiClient {
  return config.mockWebApi ? new MockSlackWebApiClient() : new FetchSlackWebApiClient();
}

export class FetchSlackWebApiClient implements SlackWebApiClient {
  readonly requiresAccessToken = true;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor({ fetchImpl = fetch, baseUrl = "https://slack.com/api" }: { fetchImpl?: typeof fetch; baseUrl?: string } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async callMethod(input: SlackWebApiCall): Promise<SlackWebApiResult> {
    if (!input.accessToken) {
      return { status: 200, body: { ok: false, error: "not_authed" } };
    }

    const url = new URL(`${this.baseUrl}/${input.method}`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${input.accessToken}`
    };
    const init: RequestInit = { method: input.httpMethod, headers };

    if (input.httpMethod === "GET") {
      appendPayload(url.searchParams, input.payload);
    } else if ((input.payloadEncoding ?? "form") === "json") {
      headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(sanitizePayload(input.payload));
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const body = new URLSearchParams();
      appendPayload(body, input.payload);
      init.body = body;
    }

    try {
      const response = await this.fetchImpl(url, init);
      const text = await response.text();
      try {
        return { status: response.status, body: JSON.parse(text), headers: response.headers };
      } catch {
        return { status: 502, body: { ok: false, error: "slack_bad_response" } };
      }
    } catch {
      return { status: 503, body: { ok: false, error: "slack_unavailable" } };
    }
  }
}

export class MockSlackWebApiClient implements SlackWebApiClient {
  async callMethod(input: SlackWebApiCall): Promise<SlackWebApiResult> {
    if (input.payload.channel === "C-MOCK-UPSTREAM-429") {
      return {
        status: 429,
        body: { ok: false, error: "slack_rate_limited" },
        headers: { "retry-after": "30", "x-slack-req-id": "mock_slack_req_rate_limited" }
      };
    }
    return { status: 200, body: mockBody(input) };
  }
}

function mockBody({ method, payload, executionMode }: SlackWebApiCall): unknown {
  if (payload.channel === "C-MOCK-ERROR") return { ok: false, error: "channel_not_found" };
  if (method === "conversations.list") {
    return {
      ok: true,
      channels: [{ id: "C-MOCK-GENERAL", name: "general", is_channel: true, is_member: executionMode === "bot" }],
      response_metadata: { next_cursor: "mock-next-cursor" }
    };
  }
  if (method === "conversations.history" || method === "conversations.replies") {
    return {
      ok: true,
      messages: [{ type: "message", channel: String(payload.channel ?? "C-MOCK-GENERAL"), user: "U-MOCK", text: "Mock message", ts: "1700000000.000100" }],
      response_metadata: { next_cursor: "mock-next-cursor" }
    };
  }
  if (method === "chat.postMessage") {
    return {
      ok: true,
      channel: String(payload.channel ?? "C-MOCK-GENERAL"),
      ts: "1700000001.000200",
      message: { type: "message", text: String(payload.text ?? ""), user: executionMode === "bot" ? "B-MOCK" : "U-MOCK" }
    };
  }
  if (method === "chat.update") return { ok: true, channel: payload.channel, ts: payload.ts, text: payload.text };
  if (method === "chat.delete") return { ok: true, channel: payload.channel, ts: payload.ts };
  if (method === "reactions.add" || method === "reactions.remove") return { ok: true };
  if (method === "reactions.get") return { ok: true, type: "message", channel: payload.channel, message: { reactions: [{ name: "thumbsup", count: 1, users: ["U-MOCK"] }] } };
  if (method === "search.messages") {
    return {
      ok: true,
      query: String(payload.query ?? ""),
      messages: { total: 1, pagination: { page: 1, page_count: 1 }, matches: [{ channel: { id: "C-MOCK-GENERAL" }, user: "U-MOCK", text: "Mock search hit" }] }
    };
  }
  if (method === "files.info") return { ok: true, file: { id: String(payload.file ?? "F-MOCK"), name: "mock.txt", mimetype: "text/plain", size: 42 } };
  if (method === "files.list") return { ok: true, files: [{ id: "F-MOCK", name: "mock.txt", mimetype: "text/plain", size: 42 }], paging: { page: 1, pages: 1, total: 1 } };
  return { ok: false, error: "method_not_supported" };
}

function appendPayload(params: URLSearchParams, payload: SlackForwardingPayload): void {
  for (const [key, value] of Object.entries(sanitizePayload(payload))) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
      continue;
    }
    params.set(key, String(value));
  }
}

function sanitizePayload(payload: SlackForwardingPayload): SlackForwardingPayload {
  const { token: _token, ...sanitized } = payload;
  return sanitized;
}
