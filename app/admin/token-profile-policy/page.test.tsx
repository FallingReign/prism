import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCurrentGlobalTokenProfilePolicy } from "../../../src/server/token-profiles/global-policy";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn()
}));
const mockCookies = vi.hoisted(() => vi.fn());

vi.mock("../../../src/server/db", () => ({ database: mockDb }));
vi.mock("next/headers", () => ({ cookies: mockCookies }));

const tempDirs: string[] = [];

describe("/admin/token-profile-policy page", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockCookies.mockReset();
    mockCookies.mockResolvedValue({ get: () => ({ value: "session-token" }) });
    delete process.env.PRISM_ADMIN_ALLOWLIST_PATH;
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from prism_sessions s")) return { rows: [adminIdentityRow()], rowCount: 1 };
      if (sql.includes("from prism_settings")) return { rows: [settingRow(buildCurrentGlobalTokenProfilePolicy())], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("renders an editable Global Token profile policy page for global admins", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "global" } }]);

    const { default: AdminTokenProfilePolicyPage } = await import("./page");
    const html = renderToStaticMarkup(await AdminTokenProfilePolicyPage());

    expect(html).toContain("Global Token profile policy");
    expect(html).toContain("Editable global scope");
    expect(html).toContain("Save policy");
    expect(html).not.toMatch(/prism_dev_|tokenHash|token_hash|pepper|xox[bp]-|access_token|refresh_token|client_secret|allowlist/i);
  });

  it("renders scoped admin policy view as read-only", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "team", teamId: "T_ADMIN" } }]);

    const { default: AdminTokenProfilePolicyPage } = await import("./page");
    const html = renderToStaticMarkup(await AdminTokenProfilePolicyPage());

    expect(html).toContain("Read-only scope");
    expect(html).toContain("Enterprise and team admins can inspect the effective policy");
    expect(html).not.toContain("Save policy");
    expect(html).not.toMatch(/allowlist|config|json|path/i);
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

function settingRow(policy: unknown) {
  return {
    value: policy,
    version: 1,
    updated_by_prism_user_id: null,
    updated_at: new Date("2026-02-01T12:00:00.000Z")
  };
}

async function writeAllowlist(admins: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-admin-policy-page-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, JSON.stringify({ admins }), "utf8");
  return allowlistPath;
}
