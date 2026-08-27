import { describe, expect, it, vi } from "vitest";

import { createPostgresTokenProfileStore } from "./store";

describe("Postgres Playtest first-party token store", () => {
  it("serializes ensure/rotation, preserves bounded overlap, and never persists the raw token", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    let profileExists = false;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.toLowerCase();
      calls.push({ sql: normalized, params });
      if (normalized.includes("from slack_connections c") && normalized.includes("for update")) {
        return rows([{ id: "connection-1" }]);
      }
      if (normalized.includes("select id, name from token_profiles")) {
        return rows(profileExists ? [{ id: "profile-playtest", name: "shg_playtest_app" }] : []);
      }
      if (normalized.includes("insert into token_profiles")) {
        profileExists = true;
        return rows([{ id: "profile-playtest", name: "shg_playtest_app" }]);
      }
      if (normalized.includes("insert into prism_activity_audit")) {
        return rows([auditRow(profileExists ? "token_profile_rotated" : "token_profile_created")]);
      }
      return rows([]);
    });
    const database = {
      query,
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(database))
    } as any;
    const store = createPostgresTokenProfileStore(database);
    const common = {
      prismUserId: "user-1",
      slackConnectionId: "connection-1",
      expiresAt: new Date("2026-08-26T08:00:00.000Z"),
      now: new Date("2026-08-26T00:00:00.000Z"),
      requestId: "request-1"
    };

    await expect(store.issuePlaytestAppToken({
      ...common,
      verifier: { tokenHash: "a".repeat(64), algorithm: "hmac-sha256", pepperId: "v1" }
    })).resolves.toEqual({ profileId: "profile-playtest" });
    await expect(store.issuePlaytestAppToken({
      ...common,
      requestId: "request-2",
      verifier: { tokenHash: "b".repeat(64), algorithm: "hmac-sha256", pepperId: "v1" }
    })).resolves.toEqual({ profileId: "profile-playtest" });

    expect(calls.filter(({ sql }) => sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
    expect(calls.filter(({ sql }) => sql.includes("insert into token_profiles"))).toHaveLength(1);
    expect(calls.filter(({ sql }) => sql.includes("insert into prism_developer_tokens"))).toHaveLength(2);
    const overlap = calls.filter(({ sql }) => sql.includes("rotation_overlap_expires_at"));
    expect(overlap).toHaveLength(2);
    expect(overlap.every(({ sql }) => sql.includes("least(coalesce(expires_at"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("prism_dev_");
  });

  it("fails closed before profile or token creation without an owned healthy user credential", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.toLowerCase().includes("from slack_connections c") ? rows([]) : rows([])
    );
    const database = {
      query,
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(database))
    } as any;
    const result = await createPostgresTokenProfileStore(database).issuePlaytestAppToken({
      prismUserId: "user-1",
      slackConnectionId: "connection-other",
      verifier: { tokenHash: "a".repeat(64), algorithm: "hmac-sha256", pepperId: "v1" },
      expiresAt: new Date("2026-08-26T08:00:00.000Z"),
      now: new Date("2026-08-26T00:00:00.000Z"),
      requestId: "request-1"
    });
    expect(result).toBeNull();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into token_profiles"))).toBe(false);
  });
});

function rows(values: unknown[]) {
  return { rows: values, rowCount: values.length };
}

function auditRow(activityType: string) {
  return {
    id: "audit-1", prism_user_id: "user-1", slack_connection_id: "connection-1",
    token_profile_id: "profile-playtest", token_profile_name: "shg_playtest_app",
    slack_user_id: null, slack_team_id: null, slack_enterprise_id: null,
    activity_type: activityType, endpoint: "/oauth/token", slack_method: null,
    action_category: "playtest_app", surface: null, object_type: null, object_id: null,
    execution_mode: null, status: activityType.endsWith("created") ? "created" : "rotated",
    error_class: null, http_status: 200, request_id: "request-1", upstream_called: false,
    occurred_at: new Date("2026-08-26T00:00:00.000Z"),
    retention_expires_at: new Date("2026-09-26T00:00:00.000Z"),
    admin_actor_prism_user_id: null, admin_actor_slack_user_id: null,
    admin_actor_slack_display_name: null, admin_reason: null
  };
}
