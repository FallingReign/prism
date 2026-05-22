import { describe, expect, it } from "vitest";

import { buildActivityAuditRecord, extractSlackObjectMetadata } from "./activity";

const now = new Date("2026-01-01T00:00:00.000Z");

describe("metadata-only activity audit", () => {
  it("builds records with 90 day default retention and omits Slack content and secret canaries", () => {
    const record = buildActivityAuditRecord(
      {
        prismUserId: "user_1",
        slackConnectionId: "conn_1",
        tokenProfileId: "profile_1",
        tokenProfileName: "Local MCP",
        slackUserId: "U123",
        slackTeamId: "T123",
        slackEnterpriseId: "E123",
        activityType: "slack_method",
        endpoint: "/v1/slack/api/chat.postMessage",
        slackMethod: "chat.postMessage",
        actionCategory: "messages.write",
        surface: "public_channel",
        objectType: "channel",
        objectId: "C123",
        executionMode: "bot",
        status: "forwarded",
        httpStatus: 200,
        requestId: "req_123",
        upstreamCalled: true,
        contentCanaries: {
          text: "MESSAGE_TEXT_CANARY",
          dm: "DM_TEXT_CANARY",
          groupDm: "GROUP_DM_TEXT_CANARY",
          thread: "THREAD_TEXT_CANARY",
          query: "RAW_SEARCH_QUERY_CANARY",
          searchResult: "SEARCH_RESULT_CANARY",
          fileContent: "FILE_CONTENT_CANARY",
          blockKit: "BLOCK_KIT_CANARY",
          canvas: "CANVAS_CONTENT_CANARY",
          list: "LIST_CONTENT_CANARY",
          developerToken: "prism_dev_sensitivecanary",
          tokenHash: "tokenHashSensitiveCanary",
          pepper: "pepper-secret-canary",
          slackAccessToken: "xoxb-sensitive-canary",
          refreshToken: "refresh-secret-canary",
          clientSecret: "client_secret_canary"
        }
      },
      { now, randomId: () => "audit_1" }
    );

    expect(record).toMatchObject({
      id: "audit_1",
      prismUserId: "user_1",
      tokenProfileId: "profile_1",
      slackMethod: "chat.postMessage",
      status: "forwarded",
      retentionExpiresAt: new Date("2026-04-01T00:00:00.000Z")
    });
    expect(JSON.stringify(record)).not.toMatch(
      /MESSAGE_TEXT_CANARY|DM_TEXT_CANARY|GROUP_DM_TEXT_CANARY|THREAD_TEXT_CANARY|RAW_SEARCH_QUERY_CANARY|SEARCH_RESULT_CANARY|FILE_CONTENT_CANARY|BLOCK_KIT_CANARY|CANVAS_CONTENT_CANARY|LIST_CONTENT_CANARY|prism_dev_|tokenHashSensitiveCanary|pepper-secret-canary|xoxb-|refresh-secret-canary|client_secret_canary/i
    );
  });

  it("extracts safe object identifiers without storing raw queries or content-bearing payloads", () => {
    expect(extractSlackObjectMetadata("chat.postMessage", { channel: "C123", text: "MESSAGE_TEXT_CANARY" })).toEqual({
      objectType: "channel",
      objectId: "C123"
    });
    expect(extractSlackObjectMetadata("files.info", { file: "F123", content: "FILE_CONTENT_CANARY" })).toEqual({ objectType: "file", objectId: "F123" });
    expect(extractSlackObjectMetadata("search.messages", { query: "RAW_SEARCH_QUERY_CANARY" })).toEqual({});
  });

  it("omits object identifiers that are not valid Slack IDs", () => {
    expect(extractSlackObjectMetadata("chat.postMessage", { channel: "prism_dev_sensitivecanary", text: "MESSAGE_TEXT_CANARY" })).toEqual({});
    expect(extractSlackObjectMetadata("conversations.history", { channel: "MESSAGE_TEXT_CANARY" })).toEqual({});
    expect(extractSlackObjectMetadata("files.info", { file: "xoxb-sensitive-canary" })).toEqual({});
    expect(extractSlackObjectMetadata("users.info", { user: "client_secret_canary" })).toEqual({});
  });
});
