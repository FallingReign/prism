import { describe, expect, it, vi } from "vitest";

import { issueApplicationProfileToken } from "./application-profile";
import { PLAYTEST_APP_CAPABILITY_MAP } from "./first-party-app";

describe("application token profile identity", () => {
  it("projects the canonical Slack user from the exact owned connection", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, " ").trim();
      if (normalized.includes("from slack_connections c") && normalized.includes("for update")) {
        expect(normalized).toContain("c.authed_user_id");
        expect(normalized).toContain("c.id = $1 and c.prism_user_id = $2");
        expect(params).toEqual(["connection-1", "prism-user-1"]);
        return rows([{
          id: "connection-1",
          installation_scope: "organization",
          authed_user_id: "U_CANONICAL",
          team_id: null,
          enterprise_id: "E1"
        }]);
      }
      if (normalized.includes("select id, name, slack_connection_id from token_profiles")) {
        return rows([{
          id: "profile-1",
          name: "Local application: remote-codex",
          slack_connection_id: "connection-1"
        }]);
      }
      return rows([]);
    });
    const database = { query } as any;

    await expect(issueApplicationProfileToken(database, {
      prismUserId: "prism-user-1",
      slackConnectionId: "connection-1",
      clientId: "remote-codex",
      profileName: "Local application: remote-codex",
      intendedUse: "Local Slack bridge",
      preset: "custom",
      capabilityMap: PLAYTEST_APP_CAPABILITY_MAP,
      expiresAt: null,
      verifier: {
        tokenHash: "a".repeat(64),
        algorithm: "hmac-sha256",
        pepperId: "v1"
      },
      rotation: "immediate",
      now: new Date("2026-09-01T00:00:00.000Z")
    })).resolves.toMatchObject({
      profileId: "profile-1",
      slackUserId: "U_CANONICAL",
      installationScope: "organization",
      slackTeamId: null,
      slackEnterpriseId: "E1"
    });
  });
});

function rows(values: unknown[]) {
  return { rows: values, rowCount: values.length };
}
