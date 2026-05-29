import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { buildCurrentGlobalTokenProfilePolicy, GLOBAL_TOKEN_PROFILE_POLICY_SETTING_KEY } from "./global-policy";
import { createPostgresGlobalTokenProfilePolicyStore } from "./global-policy-store";

describe("Postgres Global Token profile policy store", () => {
  it("reads the durable singleton settings record and falls back to current behavior when absent", async () => {
    const database = databaseWithRows([]);

    await expect(createPostgresGlobalTokenProfilePolicyStore(database).readGlobalTokenProfilePolicy()).resolves.toEqual({
      policy: buildCurrentGlobalTokenProfilePolicy(),
      version: 1,
      updatedByPrismUserId: null,
      updatedAt: null
    });

    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("from prism_settings"), [GLOBAL_TOKEN_PROFILE_POLICY_SETTING_KEY]);
  });

  it("updates the policy durably with metadata-only audit", async () => {
    const now = new Date("2026-02-01T12:00:00.000Z");
    const policy = buildCurrentGlobalTokenProfilePolicy({ presets: { allowed: ["read_only"], default: "read_only" } });
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const database: Database = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("insert into prism_settings")) {
          return {
            rows: [
              {
                value: policy,
                version: 3,
                updated_by_prism_user_id: "admin_user",
                updated_at: now
              }
            ],
            rowCount: 1
          };
        }
        if (sql.includes("insert into prism_activity_audit")) return { rows: [activityRowFromInsertParams(params)], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      transaction: vi.fn(async (callback) => callback(database))
    };

    const updated = await createPostgresGlobalTokenProfilePolicyStore(database).updateGlobalTokenProfilePolicy({
      policy,
      updatedByPrismUserId: "admin_user",
      now,
      audit: { endpoint: "/v1/prism/admin/token-profile-policy", requestId: "req_policy" }
    });

    expect(updated).toEqual({ policy, version: 3, updatedByPrismUserId: "admin_user", updatedAt: now });
    expect(queries.some(({ sql }) => sql.includes("insert into prism_settings"))).toBe(true);
    expect(queries.some(({ params }) => Array.isArray(params) && params.includes("global_token_profile_policy_updated") && params.includes("updated"))).toBe(true);
    expect(JSON.stringify(queries)).not.toMatch(/prism_dev_|tokenHash|token_hash|pepper|xox[bp]-|access_token|refresh_token|client_secret/i);
  });
});

function databaseWithRows(rows: unknown[]): Database {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    transaction: vi.fn()
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
