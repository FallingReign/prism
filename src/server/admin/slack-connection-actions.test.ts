import { describe, expect, it, vi } from "vitest";

import type { AdminAuthorizationDecision } from "./authorization";
import type { Database } from "../db";
import type { AdminUserDirectoryStore } from "./user-directory";
import { createPostgresAdminSlackConnectionActionStore, removeAdminSlackConnection, type AdminSlackConnectionActionStore } from "./slack-connection-actions";

const now = new Date("2026-02-02T12:00:00.000Z");

const admin: AdminAuthorizationDecision = {
  kind: "authorized",
  prismUserId: "admin_user",
  slackUserId: "U_ADMIN",
  slackUserDisplayName: "Ada Admin",
  teamId: "T_ADMIN",
  teamName: "Admin Team",
  enterpriseId: "E_ADMIN",
  enterpriseName: "Admin Org",
  scope: { kind: "team", teamId: "T_ADMIN" }
};

describe("admin Slack connection actions", () => {
  it("removes an in-scope target connection with admin actor and reason audit metadata", async () => {
    const connectionStore = fakeConnectionStore({
      async removeTargetCurrentConnection(input) {
        return { kind: "removed", connectionId: input.slackConnectionId, input } as const;
      }
    });

    const result = await removeAdminSlackConnection({
      decision: admin,
      directoryStore: directoryWithCurrentConnection(),
      connectionStore,
      userId: "target_user",
      reason: "  Security offboarding  ",
      confirmation: "REMOVE",
      audit: { endpoint: "/v1/prism/admin/users/target_user/slack-connection", requestId: "req_admin_remove" },
      now
    });

    expect(result).toEqual({ kind: "removed", connectionId: "conn_1", scope: { kind: "team", teamId: "T_ADMIN" } });
    expect(connectionStore.lastRemoveInput).toMatchObject({
      prismUserId: "target_user",
      slackConnectionId: "conn_1",
      audit: {
        endpoint: "/v1/prism/admin/users/target_user/slack-connection",
        requestId: "req_admin_remove",
        activityType: "admin_slack_connection_removed",
        adminActorPrismUserId: "admin_user",
        adminActorSlackUserId: "U_ADMIN",
        adminActorSlackDisplayName: "Ada Admin",
        adminReason: "Security offboarding"
      },
      now
    });
  });

  it("deletes only the target current Slack connection after writing metadata-only admin audit", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret|prism_dev_|tokenHash|token_hash|pepper/i);
      if (sql.includes("from slack_connections") && sql.includes("for update")) {
        expect(params).toEqual(["conn_1", "target_user"]);
        return {
          rows: [
            {
              id: "conn_1",
              prism_user_id: "target_user",
              authed_user_id: "U_TARGET",
              team_id: "T_ADMIN",
              enterprise_id: null
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes("insert into prism_activity_audit")) {
        expect(params?.[1]).toBe("target_user");
        expect(params?.[2]).toBe("conn_1");
        expect(params?.[5]).toBe("U_TARGET");
        expect(params?.[6]).toBe("T_ADMIN");
        expect(params?.[8]).toBe("admin_slack_connection_removed");
        expect(params?.[13]).toBe("slack_connection");
        expect(params?.[14]).toBe("conn_1");
        expect(params?.[16]).toBe("deleted");
        expect(params?.[18]).toBe(200);
        expect(params?.[20]).toBe(false);
        expect(params?.[23]).toBe("admin_user");
        expect(params?.[24]).toBe("U_ADMIN");
        expect(params?.[25]).toBe("Ada Admin");
        expect(params?.[26]).toBe("Security offboarding");
        return { rows: [activityRowFromInsertParams(params)], rowCount: 1 };
      }
      if (sql.includes("delete from slack_connections")) {
        expect(params).toEqual(["conn_1", "target_user"]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await createPostgresAdminSlackConnectionActionStore(fakeDatabase(query)).removeTargetCurrentConnection({
      prismUserId: "target_user",
      slackConnectionId: "conn_1",
      audit: {
        endpoint: "/v1/prism/admin/users/target_user/slack-connection",
        requestId: "req_admin_remove",
        activityType: "admin_slack_connection_removed",
        adminActorPrismUserId: "admin_user",
        adminActorSlackUserId: "U_ADMIN",
        adminActorSlackDisplayName: "Ada Admin",
        adminReason: "Security offboarding"
      },
      now
    });

    expect(result).toEqual({ kind: "removed", connectionId: "conn_1" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("delete from slack_connections"))).toBe(true);
  });

  it("returns generic not_found for a disconnected target without touching the mutation store", async () => {
    const connectionStore = fakeConnectionStore({});

    await expect(
      removeAdminSlackConnection({
        decision: admin,
        directoryStore: directoryWithoutCurrentConnection(),
        connectionStore,
        userId: "target_user",
        reason: "Already reset",
        confirmation: "REMOVE",
        audit: { endpoint: "/v1/prism/admin/users/target_user/slack-connection", requestId: "req_admin_remove" },
        now
      })
    ).resolves.toEqual({ kind: "not_found" });
    expect(connectionStore.lastRemoveInput).toBeUndefined();
  });
});

function directoryWithCurrentConnection(): AdminUserDirectoryStore {
  return {
    async listUsers() {
      return [];
    },
    async getUserDetail() {
      return {
        user: {
          prismUserId: "target_user",
          slackUser: { id: "U_TARGET", displayName: "Target" },
          team: { id: "T_ADMIN", name: "Admin Team" },
          enterprise: null,
          slackConnection: { id: "conn_1", status: "healthy", lastErrorClass: null, updatedAt: now.toISOString() },
          tokenProfiles: { activeCount: 1, revokedCount: 0, activeDeveloperTokenCount: 1, expiredDeveloperTokenCount: 0, revokedDeveloperTokenCount: 0 },
          latestActivityAt: null
        },
        profiles: [],
        activity: []
      };
    }
  };
}

function directoryWithoutCurrentConnection(): AdminUserDirectoryStore {
  return {
    async listUsers() {
      return [];
    },
    async getUserDetail() {
      return {
        user: {
          prismUserId: "target_user",
          slackUser: { id: "U_TARGET", displayName: "Target" },
          team: { id: "T_ADMIN", name: "Admin Team" },
          enterprise: null,
          slackConnection: { id: null, status: "not_linked", lastErrorClass: null, updatedAt: null },
          tokenProfiles: { activeCount: 0, revokedCount: 0, activeDeveloperTokenCount: 0, expiredDeveloperTokenCount: 0, revokedDeveloperTokenCount: 0 },
          latestActivityAt: null
        },
        profiles: [],
        activity: []
      };
    }
  };
}

function fakeConnectionStore(overrides: Partial<AdminSlackConnectionActionStore>): AdminSlackConnectionActionStore & {
  lastRemoveInput?: Parameters<AdminSlackConnectionActionStore["removeTargetCurrentConnection"]>[0];
} {
  return {
    async removeTargetCurrentConnection(input) {
      this.lastRemoveInput = input;
      return overrides.removeTargetCurrentConnection ? overrides.removeTargetCurrentConnection(input) : { kind: "not_found" };
    }
  };
}

function fakeDatabase(query: Database["query"]): Database {
  return {
    query,
    async transaction(callback) {
      return callback(this);
    }
  };
}

function activityRowFromInsertParams(params: unknown[] | undefined) {
  if (!params) throw new Error("expected activity params");
  return {
    id: params[0],
    prism_user_id: params[1],
    slack_connection_id: params[2],
    token_profile_id: params[3],
    token_profile_name: params[4],
    slack_user_id: params[5],
    slack_team_id: params[6],
    slack_enterprise_id: params[7],
    activity_type: params[8],
    endpoint: params[9],
    slack_method: params[10],
    action_category: params[11],
    surface: params[12],
    object_type: params[13],
    object_id: params[14],
    execution_mode: params[15],
    status: params[16],
    error_class: params[17],
    http_status: params[18],
    request_id: params[19],
    upstream_called: params[20],
    occurred_at: params[21],
    retention_expires_at: params[22],
    admin_actor_prism_user_id: params[23],
    admin_actor_slack_user_id: params[24],
    admin_actor_slack_display_name: params[25],
    admin_reason: params[26]
  };
}
