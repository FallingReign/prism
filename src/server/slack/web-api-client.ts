import "server-only";

import type { ConcreteExecutionMode } from "../token-profiles/execution-identity";

export type SlackForwardingPayload = Record<string, unknown>;

export type SlackWebApiCall = {
  method: string;
  httpMethod: "GET" | "POST";
  payload: SlackForwardingPayload;
  executionMode: ConcreteExecutionMode;
};

export type SlackWebApiResult = {
  status: number;
  body: unknown;
};

export type SlackWebApiClient = {
  callMethod(input: SlackWebApiCall): Promise<SlackWebApiResult>;
};

export function createDefaultSlackWebApiClient(): SlackWebApiClient {
  return new MockSlackWebApiClient();
}

export class MockSlackWebApiClient implements SlackWebApiClient {
  async callMethod(input: SlackWebApiCall): Promise<SlackWebApiResult> {
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
