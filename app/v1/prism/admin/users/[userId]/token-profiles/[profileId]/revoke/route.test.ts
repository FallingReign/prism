import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn()
}));

vi.mock("../../../../../../../../../src/server/db", () => ({ database: mockDb }));

const tempDirs: string[] = [];

describe("/v1/prism/admin/users/[userId]/token-profiles/[profileId]/revoke", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockDb) => Promise<unknown>) => callback(mockDb));
    mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from prism_sessions s")) return { rows: [adminIdentityRow()], rowCount: 1 };
      if (sql.includes("latest_connection")) return { rows: [directoryRow()], rowCount: 1 };
      if (sql.includes("from token_profiles p")) return { rows: [profileRow()], rowCount: 1 };
      if (sql.includes("from prism_activity_audit") && !sql.includes("insert into")) return { rows: [], rowCount: 0 };
      if (sql.includes("update prism_developer_tokens")) return { rows: [], rowCount: 1 };
      if (sql.includes("insert into prism_activity_audit")) return { rows: [activityRowFromInsertParams(params)], rowCount: 1 };
      if (sql.includes("update token_profiles")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    delete process.env.PRISM_ADMIN_ALLOWLIST_PATH;
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("revokes an in-scope target profile and records admin action audit metadata", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "team", teamId: "T_ADMIN" } }]);

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/prism/admin/users/target_user/token-profiles/profile_1/revoke", {
        method: "POST",
        headers: { cookie: "prism_session=session-token" },
        body: JSON.stringify({ confirmation: "REVOKE", reason: "Security review" })
      }),
      { params: Promise.resolve({ userId: "target_user", profileId: "profile_1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body).toMatchObject({ profile: { id: "profile_1", status: "revoked" } });
    const auditInsert = mockDb.query.mock.calls.find(([sql]) => String(sql).includes("insert into prism_activity_audit"));
    expect(auditInsert?.[1]).toEqual(expect.arrayContaining(["admin_token_profile_revoked", "admin_user", "U_ADMIN", "Ada Admin", "Security review"]));
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|xox[bp]-|access_token|refresh_token|refreshToken|client_secret|token_hash|pepper/i);
  });

  it("rejects missing reason without mutating the target profile", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "global" } }]);

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/prism/admin/users/target_user/token-profiles/profile_1/revoke", {
        method: "POST",
        headers: { cookie: "prism_session=session-token" },
        body: JSON.stringify({ confirmation: "REVOKE", reason: " " })
      }),
      { params: Promise.resolve({ userId: "target_user", profileId: "profile_1" }) }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "validation_error", message: "Admin reason is required." });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("update prism_developer_tokens"))).toBe(false);
  });

  it("rejects failed confirmation and overlong reasons before mutating the target profile", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "global" } }]);
    const { POST } = await import("./route");

    const failedConfirmation = await POST(
      new NextRequest("http://localhost:3732/v1/prism/admin/users/target_user/token-profiles/profile_1/revoke", {
        method: "POST",
        headers: { cookie: "prism_session=session-token" },
        body: JSON.stringify({ confirmation: "DELETE", reason: "Security review" })
      }),
      { params: Promise.resolve({ userId: "target_user", profileId: "profile_1" }) }
    );
    const overlongReason = await POST(
      new NextRequest("http://localhost:3732/v1/prism/admin/users/target_user/token-profiles/profile_1/revoke", {
        method: "POST",
        headers: { cookie: "prism_session=session-token" },
        body: JSON.stringify({ confirmation: "REVOKE", reason: "x".repeat(241) })
      }),
      { params: Promise.resolve({ userId: "target_user", profileId: "profile_1" }) }
    );

    expect(failedConfirmation.status).toBe(400);
    expect(await failedConfirmation.json()).toEqual({ error: "validation_error", message: "Type REVOKE to confirm this admin action." });
    expect(overlongReason.status).toBe(400);
    expect(await overlongReason.json()).toEqual({ error: "validation_error", message: "Admin reason must be 240 characters or fewer." });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("update prism_developer_tokens"))).toBe(false);
  });

  it("returns 401 for missing sessions and 403 for authenticated non-admin sessions", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_OTHER_ADMIN", scope: { kind: "global" } }]);
    const { POST } = await import("./route");

    const missing = await POST(
      new NextRequest("http://localhost:3732/v1/prism/admin/users/target_user/token-profiles/profile_1/revoke", {
        method: "POST",
        body: JSON.stringify({ confirmation: "REVOKE", reason: "Security review" })
      }),
      { params: Promise.resolve({ userId: "target_user", profileId: "profile_1" }) }
    );
    const forbidden = await POST(
      new NextRequest("http://localhost:3732/v1/prism/admin/users/target_user/token-profiles/profile_1/revoke", {
        method: "POST",
        headers: { cookie: "prism_session=session-token" },
        body: JSON.stringify({ confirmation: "REVOKE", reason: "Security review" })
      }),
      { params: Promise.resolve({ userId: "target_user", profileId: "profile_1" }) }
    );

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("update prism_developer_tokens"))).toBe(false);
  });

  it("returns generic not_found for an out-of-scope target", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "team", teamId: "T_ADMIN" } }]);
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from prism_sessions s")) return { rows: [adminIdentityRow()], rowCount: 1 };
      if (sql.includes("latest_connection")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/prism/admin/users/outside_user/token-profiles/profile_1/revoke", {
        method: "POST",
        headers: { cookie: "prism_session=session-token" },
        body: JSON.stringify({ confirmation: "REVOKE", reason: "Security review" })
      }),
      { params: Promise.resolve({ userId: "outside_user", profileId: "profile_1" }) }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("update prism_developer_tokens"))).toBe(false);
  });
});

function adminIdentityRow() {
  return {
    prism_user_id: "admin_user",
    slack_user_id: "U_ADMIN",
    slack_user_display_name: "Ada Admin",
    team_id: "T_ADMIN",
    team_name: "Admin Team",
    enterprise_id: "E_ADMIN",
    enterprise_name: "Admin Org"
  };
}

function directoryRow() {
  return {
    prism_user_id: "target_user",
    slack_user_id: "U_TARGET",
    slack_user_display_name: "Target",
    team_id: "T_ADMIN",
    team_name: "Admin Team",
    enterprise_id: "E_ADMIN",
    enterprise_name: "Admin Org",
    slack_connection_id: "conn_1",
    slack_connection_status: "healthy",
    slack_connection_last_error_class: null,
    slack_connection_updated_at: new Date("2026-02-01T12:00:00.000Z"),
    token_profile_active_count: 1,
    token_profile_revoked_count: 0,
    active_developer_token_count: 1,
    expired_developer_token_count: 0,
    revoked_developer_token_count: 0,
    latest_activity_at: null
  };
}

function profileRow() {
  return {
    id: "profile_1",
    prism_user_id: "target_user",
    slack_connection_id: "conn_1",
    name: "Target profile",
    name_normalized: "target profile",
    intended_use: "Local tool",
    preset: "read_only",
    capability_map: { version: 1, preset: "read_only", actions: { read: true }, surfaces: { publicChannels: true }, executionIdentity: "automatic" },
    expires_at: null,
    status: "active",
    policy_effective_at: new Date("2026-02-01T12:00:00.000Z"),
    created_at: new Date("2026-02-01T12:00:00.000Z"),
    updated_at: new Date("2026-02-01T12:00:00.000Z"),
    developer_token_created_at: new Date("2026-02-01T12:00:00.000Z"),
    developer_token_expires_at: null,
    developer_token_last_used_at: null,
    developer_token_revoked_at: null,
    developer_token_is_current: true,
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
    retention_expires_at: params[22],
    admin_actor_prism_user_id: params[23],
    admin_actor_slack_user_id: params[24],
    admin_actor_slack_display_name: params[25],
    admin_reason: params[26]
  };
}

async function writeAllowlist(admins: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-admin-token-profile-revoke-route-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, JSON.stringify({ admins }), "utf8");
  return allowlistPath;
}
