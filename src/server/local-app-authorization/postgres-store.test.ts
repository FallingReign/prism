import { describe, expect, it, vi } from "vitest";

import { createPostgresLocalAppAuthorizationStore } from "./postgres-store";

describe("Postgres local-app authorization store", () => {
  it("casts cleanup timestamps before PostgreSQL interval arithmetic", async () => {
    const cleanupQueries: string[] = [];
    let rateLimitInsert = "";
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("delete from prism_local_app_authorizations")) {
        cleanupQueries.push(sql);
        return rows([]);
      }
      if (sql.startsWith("delete from prism_local_app_authorization_rate_limits")) {
        cleanupQueries.push(sql);
        return rows([]);
      }
      if (sql.startsWith("insert into prism_local_app_authorization_rate_limits")) {
        rateLimitInsert = sql;
        return rows([{ request_count: 1 }]);
      }
      if (sql.includes("count(*) filter")) {
        return rows([{ global_count: "0", client_count: "0" }]);
      }
      if (sql.startsWith("insert into prism_local_app_authorizations")) {
        return rows([]);
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const database = {
      query,
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(database))
    } as any;

    await expect(createPostgresLocalAppAuthorizationStore(database).begin({
      requestId: "00000000-0000-4000-8000-000000000000",
      deviceCodeHash: "d".repeat(64),
      userCodeHash: "u".repeat(64),
      clientId: "example-local-app",
      displayName: "Example Local App",
      intendedUse: "Read and reply to Slack messages",
      sourceKey: "s".repeat(64),
      pollIntervalSeconds: 5,
      expiresAt: new Date("2026-09-01T00:10:00Z"),
      now: new Date("2026-09-01T00:00:00Z")
    })).resolves.toBe("created");

    expect(cleanupQueries).toHaveLength(2);
    expect(cleanupQueries.every((sql) =>
      sql.includes("$1::timestamptz - interval '1 day'")
    )).toBe(true);
    expect(rateLimitInsert).toContain(
      "request_count, created_at, updated_at"
    );
    expect(rateLimitInsert).toContain("values ($1, $2, $3, 1, $2, $2)");
  });

  it.each([
    ["exchanged", "invalid_grant"],
    ["denied", "denied"],
    ["policy_denied", "policy_denied"]
  ] as const)("keeps terminal %s stable across polling time and request expiry", async (status, expected) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from prism_local_app_authorizations") && sql.includes("for update")) {
        return rows([authorizationRow(status)]);
      }
      throw new Error(`unexpected query after terminal state: ${sql}`);
    });
    const database = {
      query,
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(database))
    } as any;

    const result = await createPostgresLocalAppAuthorizationStore(database).exchange({
      deviceCodeHash: "d".repeat(64),
      clientId: "example-local-app",
      now: new Date("2026-09-02T00:00:00Z"),
      issueCredential: () => { throw new Error("must not issue"); },
      auditRequestId: "audit-1"
    });

    expect(result).toEqual({ kind: expected });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("requires request-id continuation and human-code hash to identify the same row", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from prism_local_app_authorizations")) {
        expect(sql).toContain("user_code_hash = $1");
        expect(sql).toContain("($2::uuid is null or id = $2)");
        expect(params).toEqual(["u".repeat(64), "00000000-0000-4000-8000-000000000000"]);
        return rows([]);
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const database = { query } as any;
    await expect(createPostgresLocalAppAuthorizationStore(database).resolveConsent({
      userCodeHash: "u".repeat(64),
      requestId: "00000000-0000-4000-8000-000000000000",
      sessionTokenHash: "s".repeat(64),
      now: new Date("2026-09-01T00:00:00Z")
    })).resolves.toEqual({ kind: "unavailable" });
  });

  it("types the shared approval timestamp consistently across CASE expressions", async () => {
    let approvalUpdate = "";
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from prism_local_app_authorizations") && sql.includes("for update")) {
        return rows([{
          id: "00000000-0000-4000-8000-000000000000",
          client_id: "example-local-app",
          display_name: "Example Local App",
          intended_use: "Read and reply to Slack messages",
          status: "pending",
          poll_interval_seconds: 5,
          last_polled_at: null,
          approved_prism_user_id: null,
          approved_slack_connection_id: null,
          expires_at: new Date("2026-09-01T00:10:00Z")
        }]);
      }
      if (sql.includes("from prism_sessions s")) {
        return rows([{
          prism_user_id: "user-1",
          slack_connection_id: "connection-1",
          authed_user_id: "U1",
          team_id: "T1",
          enterprise_id: null
        }]);
      }
      if (sql.startsWith("update prism_local_app_authorizations")) {
        approvalUpdate = sql;
        return rows([]);
      }
      if (sql.includes("insert into prism_activity_audit")) {
        return rows([auditRow(params)]);
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const database = {
      query,
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(database))
    } as any;

    await expect(createPostgresLocalAppAuthorizationStore(database).decide({
      requestId: "00000000-0000-4000-8000-000000000000",
      sessionTokenHash: "s".repeat(64),
      decision: "approve",
      now: new Date("2026-09-01T00:01:00Z"),
      auditRequestId: "audit-approval"
    })).resolves.toBe("approved");

    expect(approvalUpdate.match(/\$5::timestamptz/g)).toHaveLength(3);
  });

  it("does not render consent again after the request is already approved", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from prism_local_app_authorizations")) {
        return rows([{
          id: "00000000-0000-4000-8000-000000000000",
          client_id: "example-local-app",
          display_name: "Example Local App",
          intended_use: "Read and reply to Slack messages",
          expires_at: new Date("2026-09-01T00:10:00Z"),
          status: "approved"
        }]);
      }
      throw new Error(`approved request must not resolve a browser identity: ${sql}`);
    });
    const database = { query } as any;
    await expect(createPostgresLocalAppAuthorizationStore(database).resolveConsent({
      userCodeHash: "u".repeat(64),
      requestId: null,
      sessionTokenHash: "s".repeat(64),
      now: new Date("2026-09-01T00:01:00Z")
    })).resolves.toEqual({ kind: "unavailable" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

function authorizationRow(status: "exchanged" | "denied" | "policy_denied") {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    client_id: "example-local-app",
    display_name: "Example Local App",
    intended_use: "Read and reply to Slack messages",
    status,
    poll_interval_seconds: 5,
    last_polled_at: new Date("2026-09-01T23:59:59Z"),
    approved_prism_user_id: "user-1",
    approved_slack_connection_id: "connection-1",
    expires_at: new Date("2026-09-01T00:10:00Z")
  };
}

function rows(values: unknown[]) {
  return { rows: values, rowCount: values.length };
}

function auditRow(params: unknown[]) {
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
