import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { AdminAllowlistUnavailableError, loadAdminAllowlist, parseAdminAllowlistContent } from "./allowlist";

const tempDirs: string[] = [];

describe("Prism admin allowlist", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("parses global, enterprise, and team scoped Prism admin entries", () => {
    expect(
      parseAdminAllowlistContent(
        JSON.stringify({
          admins: [
            { slackUserId: "U_ADMIN_GLOBAL", scope: { kind: "global" } },
            { slackUserId: "U_ADMIN_ENTERPRISE", scope: { kind: "enterprise", enterpriseId: "E_DEV_ORG" } },
            { slackUserId: "U_ADMIN_TEAM", scope: { kind: "team", teamId: "T_DEV_TEAM" } }
          ]
        })
      )
    ).toEqual({
      entries: [
        { slackUserId: "U_ADMIN_GLOBAL", scope: { kind: "global" } },
        { slackUserId: "U_ADMIN_ENTERPRISE", scope: { kind: "enterprise", enterpriseId: "E_DEV_ORG" } },
        { slackUserId: "U_ADMIN_TEAM", scope: { kind: "team", teamId: "T_DEV_TEAM" } }
      ]
    });
  });

  it("fails closed for malformed allowlist content", () => {
    expect(() => parseAdminAllowlistContent("{")).toThrow(AdminAllowlistUnavailableError);
    expect(() => parseAdminAllowlistContent(JSON.stringify({ admins: [{ slackUserId: "", scope: { kind: "global" } }] }))).toThrow(
      AdminAllowlistUnavailableError
    );
    expect(() =>
      parseAdminAllowlistContent(JSON.stringify({ admins: [{ slackUserId: "U_ADMIN", scope: { kind: "enterprise", enterpriseId: "" } }] }))
    ).toThrow(AdminAllowlistUnavailableError);
  });

  it("loads the env-configured local allowlist and treats a missing file as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prism-admin-allowlist-"));
    tempDirs.push(dir);
    const allowlistPath = join(dir, "admins.json");
    await writeFile(allowlistPath, JSON.stringify({ admins: [{ slackUserId: "U_LOCAL_ADMIN", scope: { kind: "global" } }] }), "utf8");

    await expect(loadAdminAllowlist({ PRISM_ADMIN_ALLOWLIST_PATH: allowlistPath } as NodeJS.ProcessEnv)).resolves.toEqual({
      entries: [{ slackUserId: "U_LOCAL_ADMIN", scope: { kind: "global" } }]
    });
    await expect(loadAdminAllowlist({ PRISM_ADMIN_ALLOWLIST_PATH: join(dir, "missing.json") } as NodeJS.ProcessEnv)).resolves.toEqual({
      entries: []
    });
  });
});
