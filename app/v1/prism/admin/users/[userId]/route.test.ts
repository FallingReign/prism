import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn()
}));

vi.mock("../../../../../../src/server/db", () => ({ database: mockDb }));

const tempDirs: string[] = [];

describe("/v1/prism/admin/users/[userId]", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    delete process.env.PRISM_ADMIN_ALLOWLIST_PATH;
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from prism_sessions s")) return { rows: [adminIdentityRow()], rowCount: 1 };
      if (sql.includes("latest_connection")) return { rows: [directoryRow()], rowCount: 1 };
      if (sql.includes("from token_profiles p")) return { rows: [profileRow()], rowCount: 1 };
      if (sql.includes("from prism_activity_audit")) return { rows: [activityRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns target detail for an in-scope Prism user with safe metadata only", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "global" } }]);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/users/target_user", { headers: { cookie: "prism_session=session-token" } }), {
      params: Promise.resolve({ userId: "target_user" })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body).toMatchObject({
      scope: { kind: "global" },
      detail: {
        user: { prismUserId: "target_user", slackConnection: { status: "healthy" } },
        profiles: [{ id: "profile_1", developerToken: { status: "active" } }],
        activity: [{ id: "activity_1", slackMethod: "conversations.list" }]
      }
    });
    expect(JSON.stringify(body)).not.toMatch(/xoxb-secret|access_token|refresh_token|refreshToken|client_secret|tokenHash|token_hash|pepper|prism_dev_/i);
  });

  it("returns the same generic not_found for missing and out-of-scope target users", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "team", teamId: "T_ADMIN" } }]);
    const { GET } = await import("./route");
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from prism_sessions s")) return { rows: [adminIdentityRow()], rowCount: 1 };
      if (sql.includes("latest_connection")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const missing = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/users/missing", { headers: { cookie: "prism_session=session-token" } }), {
      params: Promise.resolve({ userId: "missing" })
    });
    const outside = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/users/outside", { headers: { cookie: "prism_session=session-token" } }), {
      params: Promise.resolve({ userId: "outside" })
    });

    expect(missing.status).toBe(404);
    expect(outside.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(await outside.json()).toEqual({ error: "not_found" });
  });

  it("denies missing and non-admin sessions", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_OTHER_ADMIN", scope: { kind: "global" } }]);
    const { GET } = await import("./route");

    const missing = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/users/target_user"), {
      params: Promise.resolve({ userId: "target_user" })
    });
    expect(missing.status).toBe(401);

    const forbidden = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/users/target_user", { headers: { cookie: "prism_session=session-token" } }), {
      params: Promise.resolve({ userId: "target_user" })
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
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
    latest_activity_at: new Date("2026-02-01T12:05:00.000Z")
  };
}

function profileRow() {
  return {
    id: "profile_1",
    prism_user_id: "target_user",
    slack_connection_id: "conn_1",
    name: "Profile prism_dev_secret",
    intended_use: "Read refreshToken locally",
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
  };
}

function activityRow() {
  return {
    id: "activity_1",
    prism_user_id: "target_user",
    slack_connection_id: "conn_1",
    token_profile_id: "profile_1",
    token_profile_name: "Profile",
    slack_user_id: "U_TARGET",
    slack_team_id: "T_ADMIN",
    slack_enterprise_id: "E_ADMIN",
    activity_type: "slack_method",
    endpoint: "/v1/slack/api/conversations.list",
    slack_method: "conversations.list",
    action_category: "read",
    surface: "channel",
    object_type: "channel",
    object_id: "xoxb-secret-refresh_token-object",
    execution_mode: "automatic",
    status: "forwarded",
    error_class: "client_secret_error",
    http_status: 200,
    request_id: "req_token_hash",
    upstream_called: true,
    occurred_at: new Date("2026-02-01T12:02:00.000Z"),
    retention_expires_at: new Date("2026-05-01T12:02:00.000Z")
  };
}

async function writeAllowlist(admins: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-admin-user-detail-route-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, JSON.stringify({ admins }), "utf8");
  return allowlistPath;
}
