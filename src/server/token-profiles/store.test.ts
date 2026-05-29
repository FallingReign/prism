import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { createPostgresTokenProfileStore } from "./store";

describe("Postgres Token profile store lifecycle resolution", () => {
  it("updates last-used metadata only after resolving a known active Prism developer token", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
      if (sql.includes("from prism_developer_tokens")) {
        return {
          rows: [
            {
              developer_token_id: "devtoken_1",
              prism_user_id: "user_1",
              token_profile_id: "profile_1",
              token_profile_name: "Local MCP",
              slack_connection_id: "conn_1",
              token_expires_at: null,
              token_revoked_at: null,
              token_last_used_at: null,
              token_overlap_expires_at: null,
              token_is_current: true,
              profile_status: "active",
              profile_expires_at: null,
              preset: "read_only",
              capability_map: capabilityMap(),
              slack_status: "healthy",
              slack_team_id: "T123",
              slack_enterprise_id: null,
              slack_user_id: "U123",
              slack_last_error_class: null,
              has_user_credential: true,
              has_bot_credential: true
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes("set last_used_at")) {
        expect(sql).toContain("revoked_at is null");
        expect(sql).toContain("expires_at is null or expires_at > $2");
        expect(params).toEqual(["devtoken_1", now]);
        return { rows: [{ last_used_at: now }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const store = createPostgresTokenProfileStore(fakeDatabase(query));
    const resolved = await store.resolveDeveloperToken({ tokenHash: "hash", now });

    expect(resolved).toMatchObject({ developerTokenId: "devtoken_1", tokenProfileId: "profile_1", tokenLastUsedAt: now });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("set last_used_at"))).toHaveLength(1);
  });

  it("does not project a last-used update when the token stops matching active predicates during the update", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
      if (sql.includes("from prism_developer_tokens")) {
        return {
          rows: [
            {
              developer_token_id: "devtoken_1",
              prism_user_id: "user_1",
              token_profile_id: "profile_1",
              token_profile_name: "Local MCP",
              slack_connection_id: "conn_1",
              token_expires_at: null,
              token_revoked_at: null,
              token_last_used_at: null,
              token_overlap_expires_at: null,
              token_is_current: true,
              profile_status: "active",
              profile_expires_at: null,
              preset: "read_only",
              capability_map: capabilityMap(),
              slack_status: "healthy",
              slack_team_id: "T123",
              slack_enterprise_id: null,
              slack_user_id: "U123",
              slack_last_error_class: null,
              has_user_credential: true,
              has_bot_credential: true
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes("set last_used_at")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const store = createPostgresTokenProfileStore(fakeDatabase(query));
    const resolved = await store.resolveDeveloperToken({ tokenHash: "hash", now });

    expect(resolved).toMatchObject({ developerTokenId: "devtoken_1", tokenProfileId: "profile_1", tokenLastUsedAt: null });
  });

  it("updates Token profile policy and rotates the verifier when broadening is confirmed", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expiresAt = new Date("2099-04-01T00:00:00.000Z");
    let profileSelects = 0;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret|prism_dev_/i);
      if (sql.includes("from token_profiles p")) {
        profileSelects += 1;
        return {
          rows: [
            tokenProfileRow({
              preset: profileSelects === 1 ? "read_only" : "messages_only",
              capabilityMap: capabilityMap(profileSelects === 1 ? "read_only" : "messages_only"),
              expiresAt: profileSelects === 1 ? null : expiresAt,
              tokenExpiresAt: profileSelects === 1 ? null : expiresAt
            })
          ],
          rowCount: 1
        };
      }
      if (sql.includes("update token_profiles")) {
        expect(params).toEqual(["profile_1", "messages_only", JSON.stringify(capabilityMap("messages_only")), expiresAt, now, now]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update prism_developer_tokens")) {
        if (sql.includes("set is_current = true")) {
          expect(params).toEqual([expect.any(String)]);
          return { rows: [], rowCount: 1 };
        }
        expect(sql).toContain("revoked_at");
        expect(params).toEqual(["profile_1", now, expect.any(String)]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into prism_developer_tokens")) {
        expect(params).toEqual([expect.any(String), "profile_1", "new-token-hash", "hmac-sha256", "pepper-v1", expiresAt]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into prism_activity_audit")) {
        expect(params?.[8]).toBe("token_profile_policy_updated");
        expect(params?.[11]).toBe("messages_only");
        expect(params?.[16]).toBe("updated");
        return { rows: [activityRowFromInsertParams(params)], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const store = createPostgresTokenProfileStore(fakeDatabase(query));
    const result = await store.updateProfilePolicy({
      prismUserId: "user_1",
      slackConnectionId: "conn_1",
      profileId: "profile_1",
      preset: "messages_only",
      capabilityMap: capabilityMap("messages_only"),
      expiresAt,
      policyEffectiveAt: now,
      now,
      rotation: { verifier: { tokenHash: "new-token-hash", algorithm: "hmac-sha256", pepperId: "pepper-v1" } },
      audit: { endpoint: "/v1/prism/token-profiles/profile_1/policy", requestId: "req_policy" }
    });

    expect(result).toMatchObject({ kind: "updated", profile: { id: "profile_1", preset: "messages_only", developerToken: { status: "active", expiresAt } } });
    expect(query.mock.calls.some(([, params]) => Array.isArray(params) && params.includes("token_profile_policy_updated"))).toBe(true);
    expect(JSON.stringify(query.mock.calls)).not.toMatch(/new-token-plain|prism_dev_|pepper-secret/i);
  });

  it("lists active and revoked profiles for the manager", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
      expect(sql).toContain("p.status in ('active', 'revoked')");
      expect(params).toEqual(["user_1", "conn_1"]);
      return {
        rows: [
          tokenProfileRow({ preset: "read_only", capabilityMap: capabilityMap("read_only"), expiresAt: null, tokenExpiresAt: null, status: "active" }),
          tokenProfileRow({
            preset: "messages_only",
            capabilityMap: capabilityMap("messages_only"),
            expiresAt: null,
            tokenExpiresAt: null,
            status: "revoked",
            tokenRevokedAt: new Date("2026-01-01T00:00:00.000Z")
          })
        ],
        rowCount: 2
      };
    });

    const store = createPostgresTokenProfileStore(fakeDatabase(query));
    const profiles = await store.listProfiles({ prismUserId: "user_1", slackConnectionId: "conn_1", slackStatus: "healthy" });

    expect(profiles).toEqual([
      expect.objectContaining({ status: "active", developerToken: expect.objectContaining({ status: "active" }) }),
      expect.objectContaining({ status: "revoked", developerToken: expect.objectContaining({ status: "revoked" }) })
    ]);
  });

  it("marks the profile row revoked when access is removed", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
      if (sql.includes("from token_profiles p")) {
        return { rows: [tokenProfileRow({ preset: "read_only", capabilityMap: capabilityMap("read_only"), expiresAt: null, tokenExpiresAt: null })], rowCount: 1 };
      }
      if (sql.includes("update prism_developer_tokens")) {
        expect(params).toEqual(["profile_1", now]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into prism_activity_audit")) {
        expect(params?.[8]).toBe("token_profile_revoked");
        expect(params?.[16]).toBe("revoked");
        return { rows: [activityRowFromInsertParams(params)], rowCount: 1 };
      }
      if (sql.includes("update token_profiles")) {
        expect(sql).toContain("set status = 'revoked'");
        expect(params).toEqual(["profile_1", now]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const store = createPostgresTokenProfileStore(fakeDatabase(query));
    const result = await store.revokeProfileDeveloperTokens({
      prismUserId: "user_1",
      slackConnectionId: "conn_1",
      profileId: "profile_1",
      now,
      audit: { endpoint: "/v1/prism/token-profiles/profile_1/revoke", requestId: "req_revoke" }
    });

    expect(result).toMatchObject({ kind: "revoked", profile: { status: "revoked", developerToken: { status: "revoked", revokedAt: now } } });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("set status = 'revoked'"))).toBe(true);
  });

  it("deletes only inactive profiles and records a metadata-only deletion audit", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret|prism_dev_/i);
      if (sql.includes("from token_profiles p")) {
        return {
          rows: [
            tokenProfileRow({
              preset: "read_only",
              capabilityMap: capabilityMap("read_only"),
              expiresAt: null,
              tokenExpiresAt: null,
              status: "revoked",
              tokenRevokedAt: now
            })
          ],
          rowCount: 1
        };
      }
      if (sql.includes("insert into prism_activity_audit")) {
        expect(params?.[8]).toBe("token_profile_deleted");
        expect(params?.[16]).toBe("deleted");
        return { rows: [activityRowFromInsertParams(params)], rowCount: 1 };
      }
      if (sql.includes("delete from token_profiles")) {
        expect(sql).toContain("p.status in ('active', 'revoked')");
        expect(sql).toContain("not exists");
        expect(params).toEqual(["profile_1", "user_1", "conn_1", now]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const store = createPostgresTokenProfileStore(fakeDatabase(query));
    const result = await store.deleteInactiveProfile({
      prismUserId: "user_1",
      slackConnectionId: "conn_1",
      profileId: "profile_1",
      now,
      audit: { endpoint: "/v1/prism/token-profiles/profile_1", requestId: "req_delete" }
    });

    expect(result).toMatchObject({ kind: "deleted", profile: { id: "profile_1", status: "revoked" } });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("delete from token_profiles"))).toBe(true);
  });

  it("rejects permanent deletion when the profile still has an active current token", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret|prism_dev_/i);
      if (sql.includes("from token_profiles p")) {
        return { rows: [tokenProfileRow({ preset: "read_only", capabilityMap: capabilityMap("read_only"), expiresAt: null, tokenExpiresAt: null })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const store = createPostgresTokenProfileStore(fakeDatabase(query));
    const result = await store.deleteInactiveProfile({ prismUserId: "user_1", slackConnectionId: "conn_1", profileId: "profile_1", now });

    expect(result).toEqual({ kind: "conflict" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into prism_activity_audit"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("delete from token_profiles"))).toBe(false);
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

function tokenProfileRow({
  preset,
  capabilityMap,
  expiresAt,
  tokenExpiresAt,
  status = "active",
  tokenRevokedAt = null
}: {
  preset: "read_only" | "messages_only";
  capabilityMap: ReturnType<typeof capabilityMap>;
  expiresAt: Date | null;
  tokenExpiresAt: Date | null;
  status?: "active" | "revoked";
  tokenRevokedAt?: Date | null;
}) {
  return {
    id: "profile_1",
    prism_user_id: "user_1",
    slack_connection_id: "conn_1",
    name: "Local MCP",
    name_normalized: "local mcp",
    intended_use: "Read Slack context locally",
    preset,
    capability_map: capabilityMap,
    expires_at: expiresAt,
    status,
    policy_effective_at: new Date("2026-01-01T00:00:00.000Z"),
    created_at: new Date("2025-12-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    developer_token_created_at: new Date("2025-12-01T00:00:00.000Z"),
    developer_token_expires_at: tokenExpiresAt,
    developer_token_last_used_at: null,
    developer_token_revoked_at: tokenRevokedAt,
    developer_token_is_current: !tokenRevokedAt,
    overlap_expires_at: null
  };
}

function activityRowFromInsertParams(params: unknown[] = []) {
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
    retention_expires_at: params[22]
  };
}

function capabilityMap(preset: "read_only" | "messages_only" = "read_only") {
  const messagesOnly = preset === "messages_only";
  return {
    version: 1,
    preset,
    workspaces: { mode: "linked_slack_connection" },
    surfaces: {
      publicChannels: true,
      privateChannels: true,
      directMessages: true,
      groupDirectMessages: true,
      search: !messagesOnly,
      filesMetadata: false,
      canvases: false,
      lists: false,
      future: false
    },
    actions: { read: true, search: !messagesOnly, writeMessages: messagesOnly, reactions: messagesOnly, filesMetadata: false, destructive: false },
    executionIdentity: "automatic",
    experiment: { enabled: false, ttl: null },
    mutation: { destructiveOptIn: false, narrowingAppliesImmediately: true, broadeningRequiresRotation: true },
    deferred: { admin: false, fileTransfer: false, events: false, slashCommands: false, interactivity: false, canvases: false, lists: false }
  };
}
