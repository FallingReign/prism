import { describe, expect, it } from "vitest";

import type { ActivityAuditSummary } from "../audit/presentation";
import type { AdminAuthorizationDecision } from "./authorization";
import {
  getAdminUserDetail,
  listAdminUsers,
  type AdminUserDetail,
  type AdminUserDirectoryRow,
  type AdminUserDirectoryStore
} from "./user-directory";

const globalAdmin: AdminAuthorizationDecision = {
  kind: "authorized",
  prismUserId: "admin_user",
  slackUserId: "U_ADMIN",
  slackUserDisplayName: "Ada Admin",
  teamId: "T_ADMIN",
  teamName: "Admin Team",
  enterpriseId: "E_ADMIN",
  enterpriseName: "Admin Org",
  scope: { kind: "global" }
};

describe("Admin Prism user directory", () => {
  it("lists Prism users for an authorized admin with bounded, redacted safe metadata", async () => {
    const store = fakeStore({
      users: [
        {
          prismUserId: "target_user",
          slackUser: { id: "U_TARGET", displayName: "xoxb-secret-user" },
          team: { id: "T_TARGET", name: "Team refresh_token" },
          enterprise: { id: "E_TARGET", name: "Org token_hash" },
          slackConnection: {
            id: "conn_1",
            status: "healthy",
            lastErrorClass: "client_secret_error",
            updatedAt: "2026-02-01T12:00:00.000Z"
          },
          tokenProfiles: {
            activeCount: 2,
            revokedCount: 1,
            activeDeveloperTokenCount: 1,
            expiredDeveloperTokenCount: 1,
            revokedDeveloperTokenCount: 1
          },
          latestActivityAt: "2026-02-01T12:05:00.000Z"
        }
      ],
      detail: null
    });

    const result = await listAdminUsers({ decision: globalAdmin, store, limit: 500 });

    expect(result).toMatchObject({ kind: "users", scope: { kind: "global" } });
    expect(store.lastListInput).toEqual({ scope: { kind: "global" }, limit: 100 });
    expect(JSON.stringify(result)).not.toMatch(/xoxb-secret-user|access_token|refresh_token|refreshToken|client_secret|prism_dev_|tokenHash|token_hash|pepper/i);
  });

  it("returns generic outcomes for unauthenticated and non-admin callers", async () => {
    const store = fakeStore({ users: [], detail: null });

    await expect(listAdminUsers({ decision: { kind: "unauthenticated" }, store })).resolves.toEqual({ kind: "unauthenticated" });
    await expect(listAdminUsers({ decision: { kind: "not_admin", reason: "no_matching_entry" }, store })).resolves.toEqual({ kind: "forbidden" });
    expect(store.lastListInput).toBeUndefined();
  });

  it("returns in-scope detail with visible retained profiles and redacted metadata-only activity", async () => {
    const detail: AdminUserDetail = {
      user: {
        prismUserId: "target_user",
        slackUser: { id: "U_TARGET", displayName: "Target" },
        team: { id: "T_TARGET", name: "Target Team" },
        enterprise: null,
        slackConnection: { id: "conn_1", status: "reauth_required", lastErrorClass: "token_hash_error", updatedAt: "2026-02-01T12:00:00.000Z" },
        tokenProfiles: {
          activeCount: 1,
          revokedCount: 1,
          activeDeveloperTokenCount: 1,
          expiredDeveloperTokenCount: 0,
          revokedDeveloperTokenCount: 1
        },
        latestActivityAt: "2026-02-01T12:10:00.000Z"
      },
      profiles: [
        {
          id: "profile_1",
          name: "Profile prism_dev_secret",
          intendedUse: "Read refreshToken locally",
          preset: "read_only",
          executionIdentity: "automatic",
          expiresAt: null,
          status: "active",
          createdAt: "2026-02-01T12:00:00.000Z",
          developerToken: { status: "active", createdAt: "2026-02-01T12:00:00.000Z", expiresAt: null, lastUsedAt: null, revokedAt: null, overlapExpiresAt: null }
        }
      ],
      activity: [activity({ objectId: "access_token-object", errorClass: "pepper_error", requestId: "req_refresh_token" })]
    };
    const store = fakeStore({ users: [], detail });

    const result = await getAdminUserDetail({ decision: globalAdmin, store, userId: "target_user", activityLimit: 200, profileLimit: 200 });

    expect(result).toMatchObject({ kind: "detail", detail: { user: { prismUserId: "target_user" } } });
    expect(store.lastDetailInput).toEqual({ scope: { kind: "global" }, userId: "target_user", activityLimit: 50, profileLimit: 100 });
    expect(JSON.stringify(result)).not.toMatch(/prism_dev_secret|access_token|refresh_token|refreshToken|tokenHash|token_hash|pepper/i);
  });

  it("maps missing and out-of-scope target detail to the same not_found outcome", async () => {
    const store = fakeStore({ users: [], detail: null });

    await expect(getAdminUserDetail({ decision: globalAdmin, store, userId: "outside_scope" })).resolves.toEqual({ kind: "not_found" });
  });
});

function fakeStore({ users, detail }: { users: AdminUserDirectoryRow[]; detail: AdminUserDetail | null }): AdminUserDirectoryStore & {
  lastListInput?: unknown;
  lastDetailInput?: unknown;
} {
  return {
    async listUsers(input) {
      this.lastListInput = input;
      return users;
    },
    async getUserDetail(input) {
      this.lastDetailInput = input;
      return detail;
    }
  };
}

function activity(overrides: Partial<ActivityAuditSummary>): ActivityAuditSummary {
  return {
    id: "activity_1",
    occurredAt: "2026-02-01T12:01:00.000Z",
    activityType: "slack_method",
    status: "denied",
    tokenProfileId: "profile_1",
    tokenProfileName: "Profile",
    slackMethod: "chat.postMessage",
    actionCategory: "write",
    surface: "channel",
    objectType: "channel",
    objectId: "C123",
    executionMode: "automatic",
    errorClass: null,
    httpStatus: 403,
    upstreamCalled: false,
    requestId: "req_1",
    ...overrides
  };
}
