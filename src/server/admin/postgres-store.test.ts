import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { hashSecret } from "../slack/oauth-flow";
import { createPostgresAdminIdentityStore } from "./postgres-store";

describe("Postgres Prism admin identity store", () => {
  it("resolves safe Slack identity from a non-expired website session", async () => {
    const now = new Date("2026-02-01T12:00:00.000Z");
    const database = databaseWithRows([
      {
        prism_user_id: "prism_user_1",
        slack_user_id: "U_ADMIN",
        slack_user_display_name: "Ada Admin",
        team_id: "T_DEV",
        team_name: "Dev Workspace",
        enterprise_id: "E_ORG",
        enterprise_name: "Dev Org"
      }
    ]);

    await expect(createPostgresAdminIdentityStore(database).getCurrentIdentity({ sessionToken: "session-token", now })).resolves.toEqual({
      prismUserId: "prism_user_1",
      slackUserId: "U_ADMIN",
      slackUserDisplayName: "Ada Admin",
      teamId: "T_DEV",
      teamName: "Dev Workspace",
      enterpriseId: "E_ORG",
      enterpriseName: "Dev Org"
    });

    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("from prism_sessions s"), [hashSecret("session-token"), now]);
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("s.expires_at > $2"), expect.any(Array));
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("order by c.updated_at desc"), expect.any(Array));
  });

  it("returns null when the website session does not resolve to a current Slack connection", async () => {
    await expect(
      createPostgresAdminIdentityStore(databaseWithRows([])).getCurrentIdentity({
        sessionToken: "expired-session",
        now: new Date("2026-02-01T12:00:00.000Z")
      })
    ).resolves.toBeNull();
  });
});

function databaseWithRows(rows: unknown[]): Database {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    transaction: vi.fn()
  };
}
