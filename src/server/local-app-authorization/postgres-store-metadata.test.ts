import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ issueApplicationProfileToken: vi.fn() }));

vi.mock("../token-profiles/application-profile", () => ({
  issueApplicationProfileToken: mocks.issueApplicationProfileToken
}));

import { createPostgresLocalAppAuthorizationStore } from "./postgres-store";

describe("local-app long-lived profile metadata", () => {
  beforeEach(() => {
    mocks.issueApplicationProfileToken.mockReset();
    mocks.issueApplicationProfileToken.mockResolvedValue({
      profileId: "profile-1",
      profileName: "Local application: example-local-app",
      created: true,
      rebound: false,
      installationScope: "workspace",
      slackTeamId: "T1",
      slackEnterpriseId: null
    });
  });

  it("does not copy untrusted display or intended-use text into durable profile or audit state", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from prism_local_app_authorizations") && sql.includes("for update")) {
        return rows([{
          id: "00000000-0000-4000-8000-000000000000",
          client_id: "example-local-app",
          display_name: "UNTRUSTED DISPLAY CANARY",
          intended_use: "UNTRUSTED PURPOSE CANARY",
          status: "approved",
          poll_interval_seconds: 5,
          last_polled_at: null,
          approved_prism_user_id: "user-1",
          approved_slack_connection_id: "connection-1",
          expires_at: new Date("2026-09-01T00:10:00Z")
        }]);
      }
      if (sql.includes("from prism_settings")) return rows([]);
      if (sql.includes("from slack_connections c") && sql.includes("union all")) {
        return rows([{ team_id: "T1", team_name: "Studio" }]);
      }
      if (sql.includes("insert into prism_activity_audit")) return rows([{}]);
      return rows([]);
    });
    const database = {
      query,
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(database))
    } as any;

    await expect(createPostgresLocalAppAuthorizationStore(database).exchange({
      deviceCodeHash: "d".repeat(64),
      clientId: "example-local-app",
      now: new Date("2026-09-01T00:01:00Z"),
      issueCredential: () => ({
        developerToken: "copy-once-test-token",
        verifier: { tokenHash: "t".repeat(64), algorithm: "hmac-sha256", pepperId: "v1" }
      }),
      auditRequestId: "audit-1"
    })).resolves.toMatchObject({ kind: "issued", tokenProfileId: "profile-1" });

    expect(mocks.issueApplicationProfileToken).toHaveBeenCalledWith(database, expect.objectContaining({
      profileName: "Local application: example-local-app",
      intendedUse: "Read and send Slack messages for a paired local application."
    }));
    expect(JSON.stringify(mocks.issueApplicationProfileToken.mock.calls)).not.toContain("UNTRUSTED");
    expect(JSON.stringify(query.mock.calls.filter(([sql]) => String(sql).includes("insert into prism_activity_audit")))).not.toContain("UNTRUSTED");
  });
});

function rows(values: unknown[]) {
  return { rows: values, rowCount: values.length };
}
