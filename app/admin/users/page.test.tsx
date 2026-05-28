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

vi.mock("../../../src/server/db", () => ({ database: mockDb }));
vi.mock("next/headers", () => ({ cookies: mockCookies }));

const tempDirs: string[] = [];

describe("/admin/users page", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockCookies.mockReset();
    mockCookies.mockResolvedValue({ get: () => ({ value: "session-token" }) });
    delete process.env.PRISM_ADMIN_ALLOWLIST_PATH;
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from prism_sessions s")) return { rows: [adminIdentityRow()], rowCount: 1 };
      if (sql.includes("latest_connection")) return { rows: [directoryRow()], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("renders the scoped Prism user directory for an admin", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "global" } }]);

    const { default: AdminUsersPage } = await import("./page");
    const html = renderToStaticMarkup(await AdminUsersPage());

    expect(html).toContain("Prism user directory");
    expect(html).toContain("Target (U_TARGET)");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|access_token|refresh_token|client_secret|pepper|allowlist/i);
  });

  it("renders generic denial for non-admin sessions", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_OTHER", scope: { kind: "global" } }]);
    const { default: AdminUsersPage } = await import("./page");

    const html = renderToStaticMarkup(await AdminUsersPage());

    expect(html).toContain("Admin access unavailable");
    expect(html).not.toMatch(/U_OTHER|allowlist|config|json|path/i);
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

async function writeAllowlist(admins: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-admin-users-page-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, JSON.stringify({ admins }), "utf8");
  return allowlistPath;
}
