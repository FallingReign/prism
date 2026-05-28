import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn()
}));
const mockCookies = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/server/db", () => ({ database: mockDb }));
vi.mock("next/headers", () => ({ cookies: mockCookies }));

const tempDirs: string[] = [];

describe("/admin/users/[userId] page", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockCookies.mockReset();
    mockCookies.mockResolvedValue({ get: () => ({ value: "session-token" }) });
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

  it("renders scoped target user detail for an admin", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "global" } }]);

    const { default: AdminUserDetailPage } = await import("./page");
    const html = renderToStaticMarkup(await AdminUserDetailPage({ params: Promise.resolve({ userId: "target_user" }) }));

    expect(html).toContain("Prism user detail");
    expect(html).toContain("Target (U_TARGET)");
    expect(html).toContain("Recent Prism activity");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|access_token|refresh_token|client_secret|pepper|allowlist/i);
  });

  it("renders the same generic denial for non-admin and missing targets", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_OTHER", scope: { kind: "global" } }]);
    const { default: AdminUserDetailPage } = await import("./page");
    const forbidden = renderToStaticMarkup(await AdminUserDetailPage({ params: Promise.resolve({ userId: "target_user" }) }));
    expect(forbidden).toContain("Admin access unavailable");

    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "global" } }]);
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from prism_sessions s")) return { rows: [adminIdentityRow()], rowCount: 1 };
      if (sql.includes("latest_connection")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const missing = renderToStaticMarkup(await AdminUserDetailPage({ params: Promise.resolve({ userId: "missing" }) }));
    expect(missing).toContain("Admin access unavailable");
    expect(missing).not.toMatch(/U_OTHER|allowlist|config|json|path/i);
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
    intended_use: "Read access_token locally",
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
    object_id: "C123",
    execution_mode: "automatic",
    status: "forwarded",
    error_class: null,
    http_status: 200,
    request_id: "req_1",
    upstream_called: true,
    occurred_at: new Date("2026-02-01T12:02:00.000Z"),
    retention_expires_at: new Date("2026-05-01T12:02:00.000Z")
  };
}

async function writeAllowlist(admins: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-admin-detail-page-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, JSON.stringify({ admins }), "utf8");
  return allowlistPath;
}
