import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>()
}));

vi.mock("../../../../src/server/db", () => ({ database: mockDb }));

describe("/v1/prism/activity", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.query.mockResolvedValue({
      rows: [
        {
          id: "audit_1",
          prism_user_id: "user_1",
          slack_connection_id: "conn_1",
          token_profile_id: "profile_1",
          token_profile_name: "Local MCP",
          slack_user_id: "U123",
          slack_team_id: "T123",
          slack_enterprise_id: null,
          activity_type: "slack_method",
          endpoint: "/v1/slack/api/chat.postMessage",
          slack_method: "chat.postMessage",
          action_category: "messages.write",
          surface: "public_channel",
          object_type: "channel",
          object_id: "C123",
          execution_mode: "bot",
          status: "forwarded",
          error_class: null,
          http_status: 200,
          request_id: "req_1",
          upstream_called: true,
          occurred_at: new Date("2026-01-01T00:00:00.000Z"),
          retention_expires_at: new Date("2026-04-01T00:00:00.000Z"),
          admin_actor_prism_user_id: null,
          admin_actor_slack_user_id: null,
          admin_actor_slack_display_name: null,
          admin_reason: null
        }
      ],
      rowCount: 1
    });
  });

  it("returns current-session metadata activity without content or secret fields", async () => {
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost:3732/v1/prism/activity?limit=5", { headers: { cookie: "prism_session=session-token" } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mockDb.query.mock.calls[0]?.[0]).toContain("from prism_sessions");
    expect(body.activity).toEqual([
      {
        id: "audit_1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        activityType: "slack_method",
        status: "forwarded",
        tokenProfileId: "profile_1",
        tokenProfileName: "Local MCP",
        slackMethod: "chat.postMessage",
        actionCategory: "messages.write",
        surface: "public_channel",
        objectType: "channel",
        objectId: "C123",
        executionMode: "bot",
        errorClass: null,
        httpStatus: 200,
        upstreamCalled: true,
        requestId: "req_1",
        adminActorPrismUserId: null,
        adminActorSlackUserId: null,
        adminActorSlackDisplayName: null,
        adminReason: null
      }
    ]);
    expect(JSON.stringify(body)).not.toMatch(/text|blocks|query|content|prism_dev_|tokenHash|pepper|xox[bp]-|client_secret/i);
  });
});
