import { describe, expect, it, vi } from "vitest";

import type { Database, QueryResult } from "../db";
import { hashSecret } from "../slack/oauth-flow";
import { createPostgresActivityAuditStore } from "./postgres-store";

function emptyResult(): QueryResult {
  return { rows: [], rowCount: 0 };
}

describe("Postgres activity audit store", () => {
  it("persists explicit metadata columns and never stores payload JSON", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/payload|body|content|client_secret|\.token_hash|access_token|refresh_token/i);
      if (sql.includes("insert into prism_activity_audit")) {
        return {
          rows: [
            {
              id: params?.[0],
              prism_user_id: params?.[1],
              slack_connection_id: params?.[2],
              token_profile_id: params?.[3],
              token_profile_name: params?.[4],
              slack_user_id: params?.[5],
              slack_team_id: params?.[6],
              slack_enterprise_id: params?.[7],
              activity_type: params?.[8],
              endpoint: params?.[9],
              slack_method: params?.[10],
              action_category: params?.[11],
              surface: params?.[12],
              object_type: params?.[13],
              object_id: params?.[14],
              execution_mode: params?.[15],
              status: params?.[16],
              error_class: params?.[17],
              http_status: params?.[18],
              request_id: params?.[19],
              upstream_called: params?.[20],
              occurred_at: params?.[21],
              retention_expires_at: params?.[22]
            }
          ],
          rowCount: 1
        };
      }
      return emptyResult();
    });
    const store = createPostgresActivityAuditStore(fakeDatabase(query));

    const record = await store.recordActivity({
      prismUserId: "user_1",
      slackConnectionId: "conn_1",
      tokenProfileId: "profile_1",
      tokenProfileName: "Local MCP",
      activityType: "slack_method",
      slackMethod: "chat.postMessage",
      status: "attempted",
      occurredAt: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(record).toMatchObject({
      prismUserId: "user_1",
      slackConnectionId: "conn_1",
      tokenProfileId: "profile_1",
      tokenProfileName: "Local MCP",
      slackMethod: "chat.postMessage",
      status: "attempted"
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("persists and reads admin actor metadata on the existing activity audit table", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("admin_actor_prism_user_id");
      expect(sql).toContain("admin_actor_slack_user_id");
      expect(sql).toContain("admin_actor_slack_display_name");
      expect(sql).toContain("admin_reason");
      expect(sql).not.toMatch(/payload|body|content|client_secret|\.token_hash|access_token|refresh_token/i);
      if (sql.includes("insert into prism_activity_audit")) {
        expect(params?.[23]).toBe("admin_user");
        expect(params?.[24]).toBe("U_ADMIN");
        expect(params?.[25]).toBe("Ada Admin");
        expect(params?.[26]).toBe("Security review");
        return {
          rows: [
            {
              id: params?.[0],
              prism_user_id: params?.[1],
              slack_connection_id: params?.[2],
              token_profile_id: params?.[3],
              token_profile_name: params?.[4],
              slack_user_id: params?.[5],
              slack_team_id: params?.[6],
              slack_enterprise_id: params?.[7],
              activity_type: params?.[8],
              endpoint: params?.[9],
              slack_method: params?.[10],
              action_category: params?.[11],
              surface: params?.[12],
              object_type: params?.[13],
              object_id: params?.[14],
              execution_mode: params?.[15],
              status: params?.[16],
              error_class: params?.[17],
              http_status: params?.[18],
              request_id: params?.[19],
              upstream_called: params?.[20],
              occurred_at: params?.[21],
              retention_expires_at: params?.[22],
              admin_actor_prism_user_id: params?.[23],
              admin_actor_slack_user_id: params?.[24],
              admin_actor_slack_display_name: params?.[25],
              admin_reason: params?.[26]
            }
          ],
          rowCount: 1
        };
      }
      return emptyResult();
    });
    const store = createPostgresActivityAuditStore(fakeDatabase(query));

    const record = await store.recordActivity({
      prismUserId: "target_user",
      slackConnectionId: "conn_1",
      tokenProfileId: "profile_1",
      tokenProfileName: "Target profile",
      activityType: "admin_token_profile_revoked",
      status: "revoked",
      adminActorPrismUserId: "admin_user",
      adminActorSlackUserId: "U_ADMIN",
      adminActorSlackDisplayName: "Ada Admin",
      adminReason: "Security review",
      occurredAt: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(record).toMatchObject({
      activityType: "admin_token_profile_revoked",
      adminActorPrismUserId: "admin_user",
      adminActorSlackUserId: "U_ADMIN",
      adminActorSlackDisplayName: "Ada Admin",
      adminReason: "Security review"
    });
  });

  it("lists only current-session user activity that has not expired", async () => {
    const rows = [
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
        endpoint: "/v1/slack/api/conversations.list",
        slack_method: "conversations.list",
        action_category: "conversations.read",
        surface: "public_channel",
        object_type: null,
        object_id: null,
        execution_mode: "bot",
        status: "forwarded",
        error_class: null,
        http_status: 200,
        request_id: "req_1",
        upstream_called: true,
        occurred_at: new Date("2026-01-01T00:00:00.000Z"),
        retention_expires_at: new Date("2026-04-01T00:00:00.000Z")
      }
    ];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("from prism_sessions");
      expect(sql).toContain("a.retention_expires_at > $2");
      expect(params).toEqual([hashSecret("session-token"), new Date("2026-01-02T00:00:00.000Z"), 20]);
      return { rows, rowCount: rows.length };
    });
    const store = createPostgresActivityAuditStore(fakeDatabase(query));

    await expect(
      store.listRecentActivityForSession({
        sessionToken: "session-token",
        now: new Date("2026-01-02T00:00:00.000Z"),
        limit: 20
      })
    ).resolves.toMatchObject([
      {
        id: "audit_1",
        prismUserId: "user_1",
        slackMethod: "conversations.list",
        status: "forwarded",
        upstreamCalled: true
      }
    ]);
  });

  it("lists current-session activity for one Token profile without payload columns", async () => {
    const rows = [
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
        execution_mode: "user",
        status: "forwarded",
        error_class: null,
        http_status: 200,
        request_id: "req_1",
        upstream_called: true,
        occurred_at: new Date("2026-01-01T00:00:00.000Z"),
        retention_expires_at: new Date("2026-04-01T00:00:00.000Z")
      }
    ];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("from prism_sessions");
      expect(sql).toContain("a.token_profile_id = $3");
      expect(sql).toContain("a.retention_expires_at > $2");
      expect(sql).not.toMatch(/payload|body|content|client_secret|\.token_hash|access_token|refresh_token/i);
      expect(params).toEqual([hashSecret("session-token"), new Date("2026-01-02T00:00:00.000Z"), "profile_1", 50]);
      return { rows, rowCount: rows.length };
    });
    const store = createPostgresActivityAuditStore(fakeDatabase(query));

    await expect(
      store.listRecentActivityForTokenProfile({
        sessionToken: "session-token",
        profileId: "profile_1",
        now: new Date("2026-01-02T00:00:00.000Z"),
        limit: 99
      })
    ).resolves.toMatchObject([
      {
        id: "audit_1",
        tokenProfileId: "profile_1",
        slackMethod: "chat.postMessage",
        status: "forwarded",
        upstreamCalled: true
      }
    ]);
  });
});

function fakeDatabase(query: Database["query"]): Database {
  return {
    query,
    async transaction(callback) {
      return callback(this);
    }
  };
}
