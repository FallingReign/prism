import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn()
}));

vi.mock("../../../../../src/server/db", () => ({ database: mockDb }));

const tempDirs: string[] = [];

describe("/v1/prism/admin/users", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    delete process.env.PRISM_ADMIN_ALLOWLIST_PATH;
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from prism_sessions s")) {
        return { rows: [adminIdentityRow()], rowCount: 1 };
      }
      if (sql.includes("latest_connection")) {
        return { rows: [directoryRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("lists scoped Prism users with no-store request IDs and safe metadata", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "team", teamId: "T_ADMIN" } }]);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/users", { headers: { cookie: "prism_session=session-token" } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body).toMatchObject({
      scope: { kind: "team", teamId: "T_ADMIN" },
      users: [{ prismUserId: "target_user", slackUser: { id: "U_TARGET" }, tokenProfiles: { activeCount: 2 } }]
    });
    expect(JSON.stringify(body)).not.toMatch(/xoxb-secret|access_token|refresh_token|refreshToken|client_secret|tokenHash|token_hash|pepper|prism_dev_/i);
  });

  it("denies missing and non-admin sessions without leaking allowlist internals", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_OTHER_ADMIN", scope: { kind: "global" } }]);
    const { GET } = await import("./route");

    const missing = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/users"));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });

    const forbidden = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/users", { headers: { cookie: "prism_session=session-token" } }));
    const body = await forbidden.json();
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ error: "forbidden" });
    expect(JSON.stringify(body)).not.toMatch(/U_OTHER_ADMIN|allowlist|config|json|path/i);
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
    slack_user_display_name: "xoxb-secret-user",
    team_id: "T_ADMIN",
    team_name: "Team refresh_token",
    enterprise_id: "E_ADMIN",
    enterprise_name: "Admin Org token_hash",
    slack_connection_id: "conn_1",
    slack_connection_status: "healthy",
    slack_connection_last_error_class: "client_secret_error",
    slack_connection_updated_at: new Date("2026-02-01T12:00:00.000Z"),
    token_profile_active_count: 2,
    token_profile_revoked_count: 1,
    active_developer_token_count: 1,
    expired_developer_token_count: 1,
    revoked_developer_token_count: 1,
    latest_activity_at: new Date("2026-02-01T12:05:00.000Z")
  };
}

async function writeAllowlist(admins: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-admin-users-route-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, JSON.stringify({ admins }), "utf8");
  return allowlistPath;
}
