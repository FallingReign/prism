import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCurrentGlobalTokenProfilePolicy,
  type GlobalTokenProfilePolicy
} from "../token-profiles/global-policy";

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
      slackUserId: "U123",
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
    })).resolves.toMatchObject({
      kind: "issued",
      tokenProfileId: "profile-1",
      subject: { prismUserId: "user-1", slackUserId: "U123" }
    });

    expect(mocks.issueApplicationProfileToken).toHaveBeenCalledWith(database, expect.objectContaining({
      profileName: "Local application: example-local-app",
      intendedUse: "Read and send Slack messages for a paired local application."
    }));
    expect(JSON.stringify(mocks.issueApplicationProfileToken.mock.calls)).not.toContain("UNTRUSTED");
    expect(JSON.stringify(query.mock.calls.filter(([sql]) => String(sql).includes("insert into prism_activity_audit")))).not.toContain("UNTRUSTED");
  });

  it.each([30, 90])("uses a finite %d-day Global policy ceiling for local-app token expiry", async (maximumDays) => {
    const now = new Date("2026-09-01T00:01:00Z");
    const policy = buildCurrentGlobalTokenProfilePolicy({
      expiry: {
        maximumDays: {
          readOnly: null,
          nonDestructive: maximumDays,
          destructive: 30
        }
      }
    });
    const database = exchangeDatabase(policy);

    await expect(createPostgresLocalAppAuthorizationStore(database).exchange(exchangeInput(now)))
      .resolves.toMatchObject({ kind: "issued", tokenProfileId: "profile-1" });

    expect(mocks.issueApplicationProfileToken).toHaveBeenCalledWith(database, expect.objectContaining({
      preset: "messages_only",
      capabilityMap: expect.objectContaining({
        executionIdentity: "user",
        actions: expect.objectContaining({ writeMessages: true, reactions: true, destructive: false })
      }),
      expiresAt: new Date(now.getTime() + maximumDays * 24 * 60 * 60 * 1000),
      now
    }));
  });

  it("preserves a non-expiring local-app token when the Global policy ceiling is unlimited", async () => {
    const now = new Date("2026-09-01T00:01:00Z");
    const database = exchangeDatabase(buildCurrentGlobalTokenProfilePolicy());

    await expect(createPostgresLocalAppAuthorizationStore(database).exchange(exchangeInput(now)))
      .resolves.toMatchObject({ kind: "issued", tokenProfileId: "profile-1" });

    expect(mocks.issueApplicationProfileToken).toHaveBeenCalledWith(database, expect.objectContaining({
      expiresAt: null
    }));
  });

  it.each([
    ["preset", (policy: GlobalTokenProfilePolicy) => { policy.presets.allowed = ["read_only"]; }],
    ["identity", (policy: GlobalTokenProfilePolicy) => { policy.executionIdentities.allowed = ["automatic", "bot"]; }],
    ["capability", (policy: GlobalTokenProfilePolicy) => { policy.capabilities.maximum.actions.writeMessages = false; }]
  ] as const)("keeps incompatible %s policy terminally denied without issuing a credential", async (_reason, makeIncompatible) => {
    const policy = buildCurrentGlobalTokenProfilePolicy();
    makeIncompatible(policy);
    const issueCredential = vi.fn();
    const database = exchangeDatabase(policy);

    await expect(createPostgresLocalAppAuthorizationStore(database).exchange({
      ...exchangeInput(new Date("2026-09-01T00:01:00Z")),
      issueCredential
    })).resolves.toEqual({ kind: "policy_denied" });

    expect(issueCredential).not.toHaveBeenCalled();
    expect(mocks.issueApplicationProfileToken).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("set status = 'policy_denied'"),
      expect.any(Array)
    );
  });
});

function exchangeDatabase(policy: GlobalTokenProfilePolicy) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("from prism_local_app_authorizations") && sql.includes("for update")) {
      return rows([{
        id: "00000000-0000-4000-8000-000000000000",
        client_id: "example-local-app",
        display_name: "Example Local App",
        intended_use: "Read and reply to Slack messages",
        status: "approved",
        poll_interval_seconds: 5,
        last_polled_at: null,
        approved_prism_user_id: "user-1",
        approved_slack_connection_id: "connection-1",
        expires_at: new Date("2026-09-01T00:10:00Z")
      }]);
    }
    if (sql.includes("from prism_settings")) {
      return rows([{
        value: policy,
        version: 3,
        updated_by_prism_user_id: "admin-1",
        updated_at: new Date("2026-08-01T00:00:00Z")
      }]);
    }
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
  return database;
}

function exchangeInput(now: Date) {
  return {
    deviceCodeHash: "d".repeat(64),
    clientId: "example-local-app",
    now,
    issueCredential: () => ({
      developerToken: "copy-once-test-token",
      verifier: { tokenHash: "t".repeat(64), algorithm: "hmac-sha256" as const, pepperId: "v1" }
    }),
    auditRequestId: "audit-1"
  };
}

function rows(values: unknown[]) {
  return { rows: values, rowCount: values.length };
}
