import { describe, expect, it, vi } from "vitest";

import { createPostgresLocalAppAuthorizationStore } from "./postgres-store";

describe("Postgres local-app authorization store", () => {
  it.each([
    ["exchanged", "invalid_grant"],
    ["denied", "denied"],
    ["policy_denied", "policy_denied"]
  ] as const)("keeps terminal %s stable across polling time and request expiry", async (status, expected) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from prism_local_app_authorizations") && sql.includes("for update")) {
        return rows([authorizationRow(status)]);
      }
      throw new Error(`unexpected query after terminal state: ${sql}`);
    });
    const database = {
      query,
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(database))
    } as any;

    const result = await createPostgresLocalAppAuthorizationStore(database).exchange({
      deviceCodeHash: "d".repeat(64),
      clientId: "example-local-app",
      now: new Date("2026-09-02T00:00:00Z"),
      issueCredential: () => { throw new Error("must not issue"); },
      auditRequestId: "audit-1"
    });

    expect(result).toEqual({ kind: expected });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("requires request-id continuation and human-code hash to identify the same row", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from prism_local_app_authorizations")) {
        expect(sql).toContain("user_code_hash = $1");
        expect(sql).toContain("($2::uuid is null or id = $2)");
        expect(params).toEqual(["u".repeat(64), "00000000-0000-4000-8000-000000000000"]);
        return rows([]);
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const database = { query } as any;
    await expect(createPostgresLocalAppAuthorizationStore(database).resolveConsent({
      userCodeHash: "u".repeat(64),
      requestId: "00000000-0000-4000-8000-000000000000",
      sessionTokenHash: "s".repeat(64),
      now: new Date("2026-09-01T00:00:00Z")
    })).resolves.toEqual({ kind: "unavailable" });
  });

  it("does not render consent again after the request is already approved", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from prism_local_app_authorizations")) {
        return rows([{
          id: "00000000-0000-4000-8000-000000000000",
          client_id: "example-local-app",
          display_name: "Example Local App",
          intended_use: "Read and reply to Slack messages",
          expires_at: new Date("2026-09-01T00:10:00Z"),
          status: "approved"
        }]);
      }
      throw new Error(`approved request must not resolve a browser identity: ${sql}`);
    });
    const database = { query } as any;
    await expect(createPostgresLocalAppAuthorizationStore(database).resolveConsent({
      userCodeHash: "u".repeat(64),
      requestId: null,
      sessionTokenHash: "s".repeat(64),
      now: new Date("2026-09-01T00:01:00Z")
    })).resolves.toEqual({ kind: "unavailable" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

function authorizationRow(status: "exchanged" | "denied" | "policy_denied") {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    client_id: "example-local-app",
    display_name: "Example Local App",
    intended_use: "Read and reply to Slack messages",
    status,
    poll_interval_seconds: 5,
    last_polled_at: new Date("2026-09-01T23:59:59Z"),
    approved_prism_user_id: "user-1",
    approved_slack_connection_id: "connection-1",
    expires_at: new Date("2026-09-01T00:10:00Z")
  };
}

function rows(values: unknown[]) {
  return { rows: values, rowCount: values.length };
}
