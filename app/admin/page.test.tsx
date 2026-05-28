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

vi.mock("../../src/server/db", () => ({ database: mockDb }));
vi.mock("next/headers", () => ({ cookies: mockCookies }));

const tempDirs: string[] = [];

describe("/admin", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.query.mockResolvedValue({
      rows: [
        {
          prism_user_id: "prism_user_1",
          slack_user_id: "U_ADMIN",
          slack_user_display_name: "Ada Admin",
          team_id: "T_DEV",
          team_name: "Dev Workspace",
          enterprise_id: "E_ORG",
          enterprise_name: "Dev Org"
        }
      ],
      rowCount: 1
    });
    mockCookies.mockReset();
    mockCookies.mockResolvedValue({ get: () => ({ value: "session-token" }) });
    delete process.env.PRISM_ADMIN_ALLOWLIST_PATH;
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("renders the admin shell for an allowlisted website session", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "team", teamId: "T_DEV" } }]);

    const { default: AdminPage } = await import("./page");
    const html = renderToStaticMarkup(await AdminPage());

    expect(html).toContain("Prism admin console");
    expect(html).toContain("Active scope");
    expect(html).toContain("team");
    expect(html).not.toMatch(/prism_user_1|prism_dev_|tokenHash|xox[bp]-|access_token|refresh_token|client_secret|allowlist/i);
  });

  it("renders a generic denied state for missing and non-admin sessions", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_OTHER_ADMIN", scope: { kind: "global" } }]);

    const { default: AdminPage } = await import("./page");
    expect(renderToStaticMarkup(await AdminPage())).toContain("Admin access unavailable");

    mockCookies.mockResolvedValue({ get: () => undefined });
    expect(renderToStaticMarkup(await AdminPage())).toContain("Admin access unavailable");
  });
});

async function writeAllowlist(admins: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-admin-page-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, JSON.stringify({ admins }), "utf8");
  return allowlistPath;
}
