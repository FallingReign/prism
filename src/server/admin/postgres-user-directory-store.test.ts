import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { createPostgresAdminUserDirectoryStore } from "./postgres-user-directory-store";

describe("Postgres admin user directory store", () => {
  it("lists scoped Prism users from latest Slack connections without selecting secrets", async () => {
    const database = databaseWithResults([
      {
        rows: [
          {
            prism_user_id: "target_user",
            slack_user_id: "U_TARGET",
            slack_user_display_name: "Target",
            team_id: "T_TARGET",
            team_name: "Target Team",
            enterprise_id: "E_TARGET",
            enterprise_name: "Target Org",
            slack_connection_id: "conn_1",
            slack_connection_status: "healthy",
            slack_connection_last_error_class: null,
            slack_connection_updated_at: new Date("2026-02-01T12:00:00.000Z"),
            token_profile_active_count: 2,
            token_profile_revoked_count: 1,
            active_developer_token_count: 1,
            expired_developer_token_count: 1,
            revoked_developer_token_count: 1,
            latest_activity_at: new Date("2026-02-01T12:05:00.000Z")
          }
        ],
        rowCount: 1
      }
    ]);

    const users = await createPostgresAdminUserDirectoryStore(database).listUsers({ scope: { kind: "enterprise", enterpriseId: "E_TARGET" }, limit: 25 });

    expect(users).toEqual([
      {
        prismUserId: "target_user",
        slackUser: { id: "U_TARGET", displayName: "Target" },
        team: { id: "T_TARGET", name: "Target Team" },
        enterprise: { id: "E_TARGET", name: "Target Org" },
        slackConnection: { id: "conn_1", status: "healthy", lastErrorClass: null, updatedAt: "2026-02-01T12:00:00.000Z" },
        tokenProfiles: {
          activeCount: 2,
          revokedCount: 1,
          activeDeveloperTokenCount: 1,
          expiredDeveloperTokenCount: 1,
          revokedDeveloperTokenCount: 1
        },
        latestActivityAt: "2026-02-01T12:05:00.000Z"
      }
    ]);
    const sql = String(database.query.mock.calls[0]?.[0]);
    const params = database.query.mock.calls[0]?.[1];
    expect(sql).toContain("latest_connection");
    expect(sql).toContain("lc.enterprise_id = $1");
    expect(sql).toContain("limit $2");
    expect(sql).not.toMatch(/slack_credentials|access_token_envelope|refresh_token_envelope|token_hash|pepper_id|payload|body|content/i);
    expect(params).toEqual(["E_TARGET", 25]);
  });

  it("returns detail for an in-scope target and maps out-of-scope/missing targets to null", async () => {
    const database = databaseWithResults([
      {
        rows: [
          {
            prism_user_id: "target_user",
            slack_user_id: "U_TARGET",
            slack_user_display_name: "Target",
            team_id: "T_TARGET",
            team_name: "Target Team",
            enterprise_id: null,
            enterprise_name: null,
            slack_connection_id: "conn_1",
            slack_connection_status: "reauth_required",
            slack_connection_last_error_class: "token_expired",
            slack_connection_updated_at: new Date("2026-02-01T12:00:00.000Z"),
            token_profile_active_count: 1,
            token_profile_revoked_count: 0,
            active_developer_token_count: 1,
            expired_developer_token_count: 0,
            revoked_developer_token_count: 0,
            latest_activity_at: null
          }
        ],
        rowCount: 1
      },
      {
        rows: [
          {
            id: "profile_1",
            prism_user_id: "target_user",
            slack_connection_id: "conn_1",
            name: "Profile",
            intended_use: "Read Slack",
            preset: "read_only",
            capability_map: { version: 1, preset: "read_only", actions: { read: true }, executionIdentity: "automatic" },
            expires_at: null,
            status: "active",
            created_at: new Date("2026-02-01T12:01:00.000Z"),
            developer_token_created_at: new Date("2026-02-01T12:01:00.000Z"),
            developer_token_expires_at: null,
            developer_token_last_used_at: null,
            developer_token_revoked_at: null,
            overlap_expires_at: null
          }
        ],
        rowCount: 1
      },
      {
        rows: [
          {
            id: "activity_1",
            prism_user_id: "target_user",
            slack_connection_id: "conn_1",
            token_profile_id: "profile_1",
            token_profile_name: "Profile",
            slack_user_id: "U_TARGET",
            slack_team_id: "T_TARGET",
            slack_enterprise_id: null,
            activity_type: "slack_method",
            endpoint: "/v1/slack/api/conversations.list",
            slack_method: "conversations.list",
            action_category: "read",
            surface: "public_channel",
            object_type: "channel",
            object_id: "C123",
            execution_mode: "automatic",
            status: "forwarded",
            error_class: null,
            http_status: 200,
            request_id: "req_1",
            upstream_called: true,
            occurred_at: new Date("2026-02-01T12:02:00.000Z"),
            retention_expires_at: new Date("2026-05-01T12:02:00.000Z"),
            admin_actor_prism_user_id: "admin_user",
            admin_actor_slack_user_id: "U_ADMIN",
            admin_actor_slack_display_name: "Ada Admin",
            admin_reason: "Security review"
          }
        ],
        rowCount: 1
      }
    ]);

    const detail = await createPostgresAdminUserDirectoryStore(database).getUserDetail({
      scope: { kind: "team", teamId: "T_TARGET" },
      userId: "target_user",
      profileLimit: 10,
      activityLimit: 5
    });

    expect(detail).toMatchObject({
      user: { prismUserId: "target_user", slackConnection: { status: "reauth_required" } },
      profiles: [{ id: "profile_1", executionIdentity: "automatic", developerToken: { status: "active" } }],
      activity: [{ id: "activity_1", slackMethod: "conversations.list", adminActorSlackUserId: "U_ADMIN", adminReason: "Security review" }]
    });
    expect(String(database.query.mock.calls[0]?.[0])).toContain("lc.team_id = $1");
    expect(database.query.mock.calls[0]?.[1]).toEqual(["T_TARGET", "target_user", 1]);
    expect(String(database.query.mock.calls[1]?.[0])).not.toMatch(/token_hash|pepper_id|access_token_envelope|refresh_token_envelope/i);
    expect(String(database.query.mock.calls[1]?.[0])).toContain("limit $3");
    expect(database.query.mock.calls[1]?.[1]).toEqual(["target_user", "conn_1", 10]);
    expect(String(database.query.mock.calls[2]?.[0])).toContain("limit $3");
    expect(database.query.mock.calls[2]?.[1]).toEqual(["target_user", "conn_1", 5]);

    const missingDb = databaseWithResults([{ rows: [], rowCount: 0 }]);
    await expect(
      createPostgresAdminUserDirectoryStore(missingDb).getUserDetail({
        scope: { kind: "team", teamId: "T_TARGET" },
        userId: "outside_scope",
        profileLimit: 10,
        activityLimit: 5
      })
    ).resolves.toBeNull();
  });
});

function databaseWithResults(results: Array<{ rows: unknown[]; rowCount: number }>): Database & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => results.shift() ?? { rows: [], rowCount: 0 });
  return {
    query,
    transaction: vi.fn()
  };
}
