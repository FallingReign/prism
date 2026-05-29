import { describe, expect, it } from "vitest";

import type { AdminAuthorizationDecision } from "./authorization";
import type { AdminUserDirectoryStore } from "./user-directory";
import type { TokenProfileStore } from "../token-profiles/service";
import { deleteAdminTokenProfile, revokeAdminTokenProfile } from "./token-profile-actions";

const now = new Date("2026-02-01T12:00:00.000Z");

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

describe("admin Token profile actions", () => {
  it("revokes an in-scope target profile with admin actor and reason audit metadata", async () => {
    const directoryStore = directoryWithProfile({ status: "active", tokenStatus: "active" });
    const tokenStore = fakeTokenStore({
      async revokeProfileDeveloperTokens(input) {
        return {
          kind: "revoked",
          profile: profileMetadata({ status: "revoked" }),
          input
        } as const;
      }
    });

    const result = await revokeAdminTokenProfile({
      decision: admin,
      directoryStore,
      tokenStore,
      userId: "target_user",
      profileId: "profile_1",
      reason: "  Security review  ",
      confirmation: "REVOKE",
      audit: { endpoint: "/v1/prism/admin/users/target_user/token-profiles/profile_1/revoke", requestId: "req_admin_revoke" },
      now
    });

    expect(result).toMatchObject({ kind: "revoked", profile: { id: "profile_1", status: "revoked" } });
    expect(tokenStore.lastRevokeInput).toMatchObject({
      prismUserId: "target_user",
      slackConnectionId: "conn_1",
      profileId: "profile_1",
      audit: {
        endpoint: "/v1/prism/admin/users/target_user/token-profiles/profile_1/revoke",
        requestId: "req_admin_revoke",
        activityType: "admin_token_profile_revoked",
        adminActorPrismUserId: "admin_user",
        adminActorSlackUserId: "U_ADMIN",
        adminActorSlackDisplayName: "Ada Admin",
        adminReason: "Security review"
      }
    });
  });

  it("deletes only in-scope inactive profiles and keeps active-delete conflict semantics", async () => {
    const tokenStore = fakeTokenStore({
      async deleteInactiveProfile(input) {
        return { kind: "deleted", profile: profileMetadata({ status: "revoked" }), input } as const;
      }
    });

    await expect(
      deleteAdminTokenProfile({
        decision: admin,
        directoryStore: directoryWithProfile({ status: "revoked", tokenStatus: "revoked" }),
        tokenStore,
        userId: "target_user",
        profileId: "profile_1",
        reason: "Retired local tool",
        confirmation: "DELETE",
        audit: { endpoint: "/v1/prism/admin/users/target_user/token-profiles/profile_1", requestId: "req_admin_delete" },
        now
      })
    ).resolves.toMatchObject({ kind: "deleted", profile: { id: "profile_1" } });
    expect(tokenStore.lastDeleteInput).toMatchObject({
      prismUserId: "target_user",
      slackConnectionId: "conn_1",
      profileId: "profile_1",
      audit: {
        activityType: "admin_token_profile_deleted",
        adminReason: "Retired local tool"
      }
    });

    await expect(
      deleteAdminTokenProfile({
        decision: admin,
        directoryStore: directoryWithProfile({ status: "active", tokenStatus: "active" }),
        tokenStore,
        userId: "target_user",
        profileId: "profile_1",
        reason: "Retired local tool",
        confirmation: "DELETE",
        audit: { endpoint: "/v1/prism/admin/users/target_user/token-profiles/profile_1", requestId: "req_admin_delete" },
        now
      })
    ).resolves.toEqual({ kind: "conflict" });
  });

  it("returns generic not_found for missing, out-of-scope, or invisible target profiles", async () => {
    const disconnectedTokenStore = fakeTokenStore({});
    await expect(
      deleteAdminTokenProfile({
        decision: admin,
        directoryStore: directoryWithDisconnectedProfile(),
        tokenStore: disconnectedTokenStore,
        userId: "target_user",
        profileId: "profile_1",
        reason: "Already disconnected",
        confirmation: "DELETE",
        audit: { endpoint: "/admin", requestId: "req_admin_delete" },
        now
      })
    ).resolves.toEqual({ kind: "not_found" });
    expect(disconnectedTokenStore.lastDeleteInput).toBeUndefined();

    await expect(
      revokeAdminTokenProfile({
        decision: admin,
        directoryStore: directoryWithoutProfile(),
        tokenStore: fakeTokenStore({}),
        userId: "target_user",
        profileId: "profile_404",
        reason: "Security review",
        confirmation: "REVOKE",
        audit: { endpoint: "/admin", requestId: "req_admin_revoke" },
        now
      })
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("rejects invalid reasons and confirmation before touching stores", async () => {
    const tokenStore = fakeTokenStore({});

    await expect(
      revokeAdminTokenProfile({
        decision: admin,
        directoryStore: directoryWithProfile({ status: "active", tokenStatus: "active" }),
        tokenStore,
        userId: "target_user",
        profileId: "profile_1",
        reason: " ",
        confirmation: "REVOKE",
        audit: { endpoint: "/admin", requestId: "req_admin_revoke" },
        now
      })
    ).resolves.toEqual({ kind: "validation_error", message: "Admin reason is required." });
    await expect(
      revokeAdminTokenProfile({
        decision: admin,
        directoryStore: directoryWithProfile({ status: "active", tokenStatus: "active" }),
        tokenStore,
        userId: "target_user",
        profileId: "profile_1",
        reason: "Security review",
        confirmation: "DELETE",
        audit: { endpoint: "/admin", requestId: "req_admin_revoke" },
        now
      })
    ).resolves.toEqual({ kind: "validation_error", message: "Type REVOKE to confirm this admin action." });
    await expect(
      revokeAdminTokenProfile({
        decision: admin,
        directoryStore: directoryWithProfile({ status: "active", tokenStatus: "active" }),
        tokenStore,
        userId: "target_user",
        profileId: "profile_1",
        reason: "x".repeat(241),
        confirmation: "REVOKE",
        audit: { endpoint: "/admin", requestId: "req_admin_revoke" },
        now
      })
    ).resolves.toEqual({ kind: "validation_error", message: "Admin reason must be 240 characters or fewer." });
    expect(tokenStore.lastRevokeInput).toBeUndefined();
  });
});

function directoryWithProfile({ status, tokenStatus }: { status: "active" | "revoked"; tokenStatus: "active" | "revoked" }): AdminUserDirectoryStore {
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
          tokenProfiles: { activeCount: status === "active" ? 1 : 0, revokedCount: status === "revoked" ? 1 : 0, activeDeveloperTokenCount: tokenStatus === "active" ? 1 : 0, expiredDeveloperTokenCount: 0, revokedDeveloperTokenCount: tokenStatus === "revoked" ? 1 : 0 },
          latestActivityAt: null
        },
        profiles: [
          {
            id: "profile_1",
            name: "Target profile",
            intendedUse: "Local tool",
            preset: "read_only",
            executionIdentity: "automatic",
            capabilities: { read: true },
            expiresAt: null,
            status,
            createdAt: now.toISOString(),
            developerToken: { status: tokenStatus, createdAt: now.toISOString(), expiresAt: null, lastUsedAt: null, revokedAt: tokenStatus === "revoked" ? now.toISOString() : null, overlapExpiresAt: null }
          }
        ],
        activity: []
      };
    }
  };
}

function directoryWithDisconnectedProfile(): AdminUserDirectoryStore {
  return {
    async listUsers() {
      return [];
    },
    async getUserDetail() {
      const detail = await directoryWithProfile({ status: "revoked", tokenStatus: "revoked" }).getUserDetail({
        scope: { kind: "team", teamId: "T_ADMIN" },
        userId: "target_user",
        profileLimit: 100,
        activityLimit: 1
      });
      if (!detail) throw new Error("expected detail");
      return {
        ...detail,
        user: {
          ...detail.user,
          slackConnection: { id: null, status: "not_linked", lastErrorClass: null, updatedAt: null }
        }
      };
    }
  };
}

function directoryWithoutProfile(): AdminUserDirectoryStore {
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
          tokenProfiles: { activeCount: 0, revokedCount: 0, activeDeveloperTokenCount: 0, expiredDeveloperTokenCount: 0, revokedDeveloperTokenCount: 0 },
          latestActivityAt: null
        },
        profiles: [],
        activity: []
      };
    }
  };
}

function fakeTokenStore(overrides: Partial<TokenProfileStore>): TokenProfileStore & {
  lastRevokeInput?: Parameters<TokenProfileStore["revokeProfileDeveloperTokens"]>[0];
  lastDeleteInput?: Parameters<TokenProfileStore["deleteInactiveProfile"]>[0];
} {
  return {
    async resolveOwner() {
      return null;
    },
    async listProfiles() {
      return [];
    },
    async insertProfileWithVerifier() {
      return { kind: "duplicate_name" };
    },
    async revokeProfileDeveloperTokens(input) {
      this.lastRevokeInput = input;
      return overrides.revokeProfileDeveloperTokens ? overrides.revokeProfileDeveloperTokens(input) : { kind: "not_found" };
    },
    async rotateProfileDeveloperToken() {
      return { kind: "not_found" };
    },
    async updateProfilePolicy() {
      return { kind: "not_found" };
    },
    async deleteInactiveProfile(input) {
      this.lastDeleteInput = input;
      return overrides.deleteInactiveProfile ? overrides.deleteInactiveProfile(input) : { kind: "not_found" };
    }
  };
}

function profileMetadata({ status }: { status: "active" | "revoked" }) {
  return {
    id: "profile_1",
    prismUserId: "target_user",
    slackConnectionId: "conn_1",
    name: "Target profile",
    nameNormalized: "target profile",
    intendedUse: "Local tool",
    preset: "read_only",
    capabilityMap: { version: 1, preset: "read_only", actions: { read: true }, surfaces: { publicChannels: true }, executionIdentity: "automatic" },
    expiresAt: null,
    status,
    developerToken: { status: status === "active" ? "active" : "revoked", createdAt: now, expiresAt: null, lastUsedAt: null, revokedAt: status === "revoked" ? now : null, overlapExpiresAt: null },
    globalPolicyStatus: { kind: "inside", reasons: [] },
    policyEffectiveAt: now,
    createdAt: now,
    updatedAt: now
  } as const;
}
