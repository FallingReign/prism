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

describe("/v1/prism/admin/session", () => {
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
    delete process.env.PRISM_ADMIN_ALLOWLIST_PATH;
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns the active Prism admin scope for an allowlisted website session", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "global" } }]);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/session", { headers: { cookie: "prism_session=session-token" } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body).toEqual({
      admin: true,
      scope: { kind: "global" },
      slackUser: { id: "U_ADMIN", displayName: "Ada Admin" },
      team: { id: "T_DEV", name: "Dev Workspace" },
      enterprise: { id: "E_ORG", name: "Dev Org" }
    });
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper|access_token|refresh_token|client_secret|allowlist/i);
  });

  it("returns enterprise and team admin decisions through the public admin API", async () => {
    const { GET } = await import("./route");

    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "enterprise", enterpriseId: "E_ORG" } }]);
    const enterprise = await GET(
      new NextRequest("http://localhost:3732/v1/prism/admin/session", { headers: { cookie: "prism_session=session-token" } })
    );
    const enterpriseBody = await enterprise.json();
    expect(enterprise.status).toBe(200);
    expect(enterprise.headers.get("cache-control")).toBe("no-store");
    expect(enterprise.headers.get("x-prism-request-id")).toBeTruthy();
    expect(enterpriseBody).toMatchObject({ admin: true, scope: { kind: "enterprise", enterpriseId: "E_ORG" } });

    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "team", teamId: "T_DEV" } }]);
    const team = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/session", { headers: { cookie: "prism_session=session-token" } }));
    const teamBody = await team.json();
    expect(team.status).toBe(200);
    expect(team.headers.get("cache-control")).toBe("no-store");
    expect(team.headers.get("x-prism-request-id")).toBeTruthy();
    expect(teamBody).toMatchObject({ admin: true, scope: { kind: "team", teamId: "T_DEV" } });
    expect(JSON.stringify([enterpriseBody, teamBody])).not.toMatch(/prism_dev_|tokenHash|pepper|access_token|refresh_token|client_secret|allowlist/i);
  });

  it("denies missing sessions and authenticated non-admins without leaking allowlist internals", async () => {
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_OTHER_ADMIN", scope: { kind: "global" } }]);
    const { GET } = await import("./route");

    const missing = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/session"));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });

    const nonAdmin = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/session", { headers: { cookie: "prism_session=session-token" } }));
    const body = await nonAdmin.json();
    expect(nonAdmin.status).toBe(403);
    expect(nonAdmin.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ error: "forbidden" });
    expect(JSON.stringify(body)).not.toMatch(/U_OTHER_ADMIN|allowlist|config|json|path/i);
  });

  it("denies expired sessions and same-user scope mismatches through the public admin API", async () => {
    const { GET } = await import("./route");

    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "global" } }]);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const expired = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/session", { headers: { cookie: "prism_session=expired-session" } }));
    expect(expired.status).toBe(401);
    expect(expired.headers.get("cache-control")).toBe("no-store");
    expect(expired.headers.get("x-prism-request-id")).toBeTruthy();
    expect(await expired.json()).toEqual({ error: "unauthorized" });

    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "team", teamId: "T_OUT_OF_SCOPE" } }]);
    const mismatch = await GET(
      new NextRequest("http://localhost:3732/v1/prism/admin/session", { headers: { cookie: "prism_session=session-token" } })
    );
    const body = await mismatch.json();
    expect(mismatch.status).toBe(403);
    expect(mismatch.headers.get("cache-control")).toBe("no-store");
    expect(mismatch.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body).toEqual({ error: "forbidden" });
    expect(JSON.stringify(body)).not.toMatch(/T_OUT_OF_SCOPE|allowlist|config|json|path/i);
  });

  it("fails closed when the local admin allowlist is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prism-admin-route-"));
    tempDirs.push(dir);
    const allowlistPath = join(dir, "admins.json");
    await writeFile(allowlistPath, "{", "utf8");
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = allowlistPath;

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost:3732/v1/prism/admin/session", { headers: { cookie: "prism_session=session-token" } }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "admin_unavailable" });
  });
});

async function writeAllowlist(admins: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-admin-route-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, JSON.stringify({ admins }), "utf8");
  return allowlistPath;
}
