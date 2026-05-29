import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCurrentGlobalTokenProfilePolicy } from "../../../../../src/server/token-profiles/global-policy";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn<(callback: (db: typeof mockDb) => Promise<unknown>) => Promise<unknown>>()
}));

vi.mock("../../../../../src/server/db", () => ({ database: mockDb }));

const tempDirs: string[] = [];

describe("/v1/prism/admin/token-profile-policy", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (callback) => callback(mockDb));
    delete process.env.PRISM_ADMIN_ALLOWLIST_PATH;
    mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from prism_sessions s")) return { rows: [adminIdentityRow()], rowCount: 1 };
      if (sql.includes("from prism_settings")) return { rows: [settingRow(buildCurrentGlobalTokenProfilePolicy())], rowCount: 1 };
      if (sql.includes("insert into prism_settings")) return { rows: [settingRow(JSON.parse(String(params?.[1])), 2, "admin_user")], rowCount: 1 };
      if (sql.includes("insert into prism_activity_audit")) return { rows: [activityRowFromInsertParams(params)], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("lets scoped admins view the effective policy as read-only", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "team", teamId: "T_ADMIN" } }]);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/token-profile-policy", { headers: { cookie: "prism_session=session-token" } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body).toMatchObject({ editable: false, scope: { kind: "team", teamId: "T_ADMIN" }, policy: { presets: { default: "read_only" } } });
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|token_hash|pepper|xox[bp]-|access_token|refresh_token|client_secret|allowlist/i);
  });

  it("lets global admins update the policy with metadata-only audit", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "global" } }]);
    const policy = buildCurrentGlobalTokenProfilePolicy({ presets: { allowed: ["read_only"], default: "read_only" } });

    const { PATCH } = await import("./route");
    const response = await PATCH(
      new NextRequest("http://localhost:3732/v1/prism/admin/token-profile-policy", {
        method: "PATCH",
        headers: { cookie: "prism_session=session-token", "content-type": "application/json" },
        body: JSON.stringify({ policy, tokenHash: "token_hash_secret", refresh_token: "xoxp-secret" })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ editable: true, version: 2, policy: { presets: { allowed: ["read_only"] } } });
    expect(mockDb.query.mock.calls.some(([, params]) => Array.isArray(params) && params.includes("global_token_profile_policy_updated"))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/token_hash_secret|refresh_token|xoxp-secret|pepper|client_secret/i);
  });

  it("forbids scoped admin updates without leaking allowlist internals", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "enterprise", enterpriseId: "E_ADMIN" } }]);

    const { PATCH } = await import("./route");
    const response = await PATCH(
      new NextRequest("http://localhost:3732/v1/prism/admin/token-profile-policy", {
        method: "PATCH",
        headers: { cookie: "prism_session=session-token", "content-type": "application/json" },
        body: JSON.stringify({ policy: buildCurrentGlobalTokenProfilePolicy() })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: "forbidden" });
    expect(JSON.stringify(body)).not.toMatch(/allowlist|config|json|path|U_ADMIN/i);
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

function settingRow(policy: unknown, version = 1, updatedByPrismUserId: string | null = null) {
  return {
    value: policy,
    version,
    updated_by_prism_user_id: updatedByPrismUserId,
    updated_at: new Date("2026-02-01T12:00:00.000Z")
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

async function writeAllowlist(admins: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-admin-policy-route-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, JSON.stringify({ admins }), "utf8");
  return allowlistPath;
}
