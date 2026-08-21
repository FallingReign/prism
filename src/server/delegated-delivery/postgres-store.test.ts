import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import type { CredentialEnvelope } from "../credentials/encryption";
import {
  createPostgresDelegatedDeliveryStore,
  runPostgresDelegatedDeliveryCleanup
} from "./postgres-store";
import type { DelegatedStoreLimits } from "./store";
import { DelegatedDeliveryStoreError, type DelegationRequestInput } from "./types";

const now = new Date("2026-08-22T00:00:00.000Z");
const approvalExpiresAt = new Date("2026-08-22T00:10:00.000Z");
const deliveryExpiresAt = new Date("2026-08-22T00:35:00.000Z");
const envelope: CredentialEnvelope = {
  algorithm: "local-aes-256-gcm-v1",
  keyId: "delegation-key-v1",
  iv: "aXYtaXYtaXYtaXYt",
  tag: "dGFnLXRhZy10YWctdGFnLXRhZw==",
  ciphertext: "ZW5jcnlwdGVk"
};
const limits: DelegatedStoreLimits = {
  statusRetentionMs: 30 * 24 * 60 * 60_000,
  rateWindowMs: 60_000,
  maxRequestsPerSource: 30,
  maxRequestsPerClient: 300,
  maxRequestsPerUser: 30,
  maxRequestsPerChannel: 60,
  maxOutstandingPendingPerSource: 10,
  maxOutstandingPendingPerClient: 500,
  maxOutstandingPendingPerUser: 20,
  cleanupBatchSize: 25
};

function requestInput(): DelegationRequestInput {
  return {
    clientId: "shg-playtest-delegation",
    callbackUri: "https://playtest.example/api/announcements/delegation/callback",
    externalJobId: "job-123",
    revision: 1,
    idempotencyKey: "job-123:1",
    expectedPrismUserId: "prism-user-123",
    teamId: "T123ABC",
    channelId: "C123ABC",
    action: "chat.postMessage",
    executionMode: "user",
    payload: { channel: "C123ABC", text: "DATABASE_PLAINTEXT_CANARY", blocks: [] },
    canonicalPayload: '{"blocks":[],"channel":"C123ABC","text":"DATABASE_PLAINTEXT_CANARY"}',
    payloadSha256: "a".repeat(64),
    notBefore: new Date("2026-08-22T00:05:00.000Z"),
    deliveryExpiresAt,
    returnState: "s".repeat(43),
    codeChallenge: "c".repeat(43),
    codeChallengeMethod: "S256",
    dpopJkt: "j".repeat(43),
    immutableDigest: "d".repeat(64)
  };
}

describe("Postgres delegated delivery issuance store", () => {
  it("persists only encrypted operational content with bounded cleanup and hash-only proof material", async () => {
    const requestInsertParams: unknown[][] = [];
    const cleanupCalls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("with targets") && (
        sql.includes("slack_delivery_delegation_requests") ||
        sql.includes("slack_delivery_grants")
      )) {
        cleanupCalls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("with targets") && sql.includes("delete from")) {
        cleanupCalls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("insert into slack_delivery_dpop_replay")) {
        expect(params[1]).toMatch(/^[a-f0-9]{64}$/);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into slack_delivery_rate_limits")) {
        return { rows: [{ request_count: 1, window_reset_at: new Date(now.getTime() + 60_000) }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("approval_handle_envelope, immutable_digest")) return { rows: [], rowCount: 0 };
      if (sql.includes("client_count")) {
        return { rows: [{ client_count: 0, source_count: 0, user_count: 0, client_retry_at: null, source_retry_at: null, user_retry_at: null }], rowCount: 1 };
      }
      if (sql.includes("insert into slack_delivery_delegation_requests")) {
        requestInsertParams.push(params);
        return { rows: [requestRow()], rowCount: 1 };
      }
      if (sql.includes("insert into prism_activity_audit")) return { rows: [auditRow("created")], rowCount: 1 };
      throw new Error(`unexpected-sql:${sql.slice(0, 80)}`);
    });
    const store = createPostgresDelegatedDeliveryStore(fakeDatabase(query));

    await expect(store.createRequest({
      requestId: "ddr_1234567890123456",
      approvalHandleHash: "h".repeat(64),
      approvalHandleEnvelope: envelope,
      sourceIdentifier: "192.0.2.1",
      request: requestInput(),
      payloadEnvelope: envelope,
      returnStateEnvelope: envelope,
      approvalExpiresAt,
      proofReplay: { jkt: "k".repeat(43), jtiHash: "f".repeat(64), expiresAt: new Date("2026-08-22T00:02:00.000Z") },
      limits,
      now
    })).resolves.toMatchObject({ kind: "created", request: { id: "ddr_1234567890123456" } });

    expect(requestInsertParams).toHaveLength(1);
    const persisted = JSON.stringify(requestInsertParams[0]);
    expect(persisted).not.toContain("DATABASE_PLAINTEXT_CANARY");
    expect(persisted).not.toContain("s".repeat(43));
    expect(persisted).not.toContain("client-proof-jti");
    expect(cleanupCalls).toHaveLength(9);
    expect(cleanupCalls.every(({ sql }) => /limit \$2/i.test(sql))).toBe(true);
    expect(cleanupCalls.some(({ sql }) => sql.includes("state in ('active', 'executing')"))).toBe(true);
    expect(cleanupCalls.some(({ sql }) => sql.includes("not exists (\n               select 1 from slack_delivery_authorization_codes"))).toBe(true);
    expect(cleanupCalls.some(({ sql }) => sql.includes("status_retained_until <= $1"))).toBe(true);
    expect(cleanupCalls.some(({ sql }) =>
      sql.includes("select state_hash from slack_oauth_states") &&
      sql.includes("where expires_at <= $1") &&
      sql.includes("delete from slack_oauth_states")
    )).toBe(true);
    const terminalRequestCleanup = cleanupCalls.find(({ sql }) =>
      sql.includes("r.terminal_at <= $1") && sql.includes("delete from slack_delivery_delegation_requests")
    );
    expect(terminalRequestCleanup?.params).toEqual([
      new Date("2026-07-23T00:00:00.000Z"),
      limits.cleanupBatchSize
    ]);
    expect(terminalRequestCleanup?.sql).toContain(
      "s.delegated_delivery_request_id = r.id"
    );
  });

  it("exposes one bounded transactional maintenance pass independent of new issuance", async () => {
    const cleanupCalls: Array<{ sql: string; params: unknown[] }> = [];
    let transactions = 0;
    const maintenanceDatabase: Database = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        cleanupCalls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }) as Database["query"],
      async transaction<T>(callback: (database: Database) => Promise<T>): Promise<T> {
        transactions += 1;
        return callback(maintenanceDatabase);
      }
    };

    await expect(runPostgresDelegatedDeliveryCleanup({
      database: maintenanceDatabase,
      now,
      statusRetentionMs: limits.statusRetentionMs,
      batchSize: limits.cleanupBatchSize
    })).resolves.toEqual({
      expiredPendingRequests: 0,
      expiredApprovedRequests: 0,
      expiredGrants: 0,
      deletedAuthorizationCodes: 0,
      deletedDpopReplays: 0,
      deletedRateBuckets: 0,
      deletedSlackOAuthStates: 0,
      deletedTerminalGrants: 0,
      deletedTerminalRequests: 0
    });

    expect(transactions).toBe(1);
    expect(cleanupCalls).toHaveLength(9);
    expect(cleanupCalls.every(({ sql, params }) =>
      /limit \$2/i.test(sql) && params[1] === limits.cleanupBatchSize
    )).toBe(true);
    const oauthCleanup = cleanupCalls.find(({ sql }) =>
      sql.includes("select state_hash from slack_oauth_states")
    );
    expect(oauthCleanup?.sql).not.toContain("continuation_type");
    const requestCleanup = cleanupCalls.find(({ sql }) =>
      sql.includes("delete from slack_delivery_delegation_requests")
    );
    expect(requestCleanup?.sql).toContain(
      "not exists (\n           select 1 from slack_oauth_states"
    );
    await expect(runPostgresDelegatedDeliveryCleanup({
      database: maintenanceDatabase,
      now,
      statusRetentionMs: limits.statusRetentionMs,
      batchSize: 1001
    })).rejects.toThrow("invalid-delegated-delivery-cleanup-limits");
  });

  it.each([
    ["search:read", "policy_denied"],
    ["search:read,chat:write", "ready"]
  ] as const)("requires an actual user credential with chat:write (%s)", async (userScopes, expectedKind) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("where approval_handle_hash = $1 or oauth_resume_handle_hash = $1")) {
        return { rows: [requestRow()], rowCount: 1 };
      }
      if (sql.includes("select prism_user_id from prism_sessions")) {
        return { rows: [{ prism_user_id: "prism-user-123" }], rowCount: 1 };
      }
      if (sql.includes("join slack_credentials cred")) {
        expect(sql).toContain("cred.kind = 'user'");
        expect(sql).toContain("s.prism_user_id = $3");
        expect(sql).toContain("c.team_id = $4");
        expect(sql).toContain("c.status = 'healthy'");
        return {
          rows: [{
            prism_user_id: "prism-user-123",
            slack_connection_id: "connection-1",
            slack_user_id: "U0123456789",
            slack_user_display_name: "Ada",
            team_id: "T123ABC",
            team_name: "Studio",
            user_scopes: userScopes
          }],
          rowCount: 1
        };
      }
      throw new Error(`unexpected-sql:${sql.slice(0, 80)}`);
    });
    const store = createPostgresDelegatedDeliveryStore(fakeDatabase(query));

    const result = await store.loadConsent({
      handleHash: "h".repeat(64),
      sessionTokenHash: "session-hash",
      now
    });

    expect(result.kind).toBe(expectedKind);
    if (expectedKind === "ready" && result.kind === "ready") {
      expect(result.identity).toMatchObject({
        prismUserId: "prism-user-123",
        slackUserId: "U0123456789",
        teamId: "T123ABC"
      });
    }
  });

  it("rejects a replay atomically before request or audit persistence", async () => {
    const sqlCalls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes("with targets")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into slack_delivery_dpop_replay")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const store = createPostgresDelegatedDeliveryStore(fakeDatabase(query));

    await expect(store.createRequest({
      requestId: "ddr_1234567890123456",
      approvalHandleHash: "h".repeat(64),
      approvalHandleEnvelope: envelope,
      sourceIdentifier: "192.0.2.1",
      request: requestInput(),
      payloadEnvelope: envelope,
      returnStateEnvelope: envelope,
      approvalExpiresAt,
      proofReplay: { jkt: "k".repeat(43), jtiHash: "f".repeat(64), expiresAt: new Date("2026-08-22T00:02:00.000Z") },
      limits,
      now
    })).rejects.toMatchObject({ code: "proof_replay" } satisfies Partial<DelegatedDeliveryStoreError>);
    expect(sqlCalls.some((sql) => sql.includes("insert into slack_delivery_delegation_requests"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("insert into prism_activity_audit"))).toBe(false);
  });

  it("does not turn unattributed direct traffic into one attacker-exhaustible source bucket", async () => {
    let rateBuckets = 0;
    let advisoryLocks = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("with targets")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into slack_delivery_dpop_replay")) return { rows: [], rowCount: 1 };
      if (sql.includes("insert into slack_delivery_rate_limits")) {
        rateBuckets += 1;
        return { rows: [{ request_count: 1, window_reset_at: new Date(now.getTime() + 60_000) }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        advisoryLocks += 1;
        return { rows: [{}], rowCount: 1 };
      }
      if (sql.includes("approval_handle_envelope, immutable_digest")) return { rows: [], rowCount: 0 };
      if (sql.includes("client_count")) {
        return {
          rows: [{
            client_count: 0,
            source_count: 999,
            user_count: 0,
            client_retry_at: null,
            source_retry_at: approvalExpiresAt,
            user_retry_at: null
          }],
          rowCount: 1
        };
      }
      if (sql.includes("insert into slack_delivery_delegation_requests")) return { rows: [requestRow()], rowCount: 1 };
      if (sql.includes("insert into prism_activity_audit")) return { rows: [auditRow("created")], rowCount: 1 };
      throw new Error(`unexpected-sql:${sql.slice(0, 80)}`);
    });
    const store = createPostgresDelegatedDeliveryStore(fakeDatabase(query));

    await expect(store.createRequest({
      requestId: "ddr_1234567890123456",
      approvalHandleHash: "h".repeat(64),
      approvalHandleEnvelope: envelope,
      sourceIdentifier: "unattributed",
      request: requestInput(),
      payloadEnvelope: envelope,
      returnStateEnvelope: envelope,
      approvalExpiresAt,
      proofReplay: { jkt: "k".repeat(43), jtiHash: "f".repeat(64), expiresAt: new Date("2026-08-22T00:02:00.000Z") },
      limits,
      now
    })).resolves.toMatchObject({ kind: "created" });

    expect(rateBuckets).toBe(3);
    expect(advisoryLocks).toBe(2);
  });

  it("serializes concurrent approvals so one code and one approval audit win", async () => {
    let state: "pending" | "approved" = "pending";
    let codeInserts = 0;
    let auditInserts = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from slack_delivery_delegation_requests where id = $1 for update")) {
        return { rows: [{ ...requestRow(), state }], rowCount: 1 };
      }
      if (sql.includes("from prism_sessions s") && sql.includes("slack_credentials")) {
        return {
          rows: [{ prism_user_id: "prism-user-123", slack_connection_id: "connection-1", slack_user_id: "U123", slack_user_display_name: "Ada", team_id: "T123ABC", team_name: "Studio", user_scopes: "openid,chat:write" }],
          rowCount: 1
        };
      }
      if (sql.includes("set state = 'approved'")) {
        state = "approved";
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into slack_delivery_authorization_codes")) {
        codeInserts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into prism_activity_audit")) {
        auditInserts += 1;
        return { rows: [auditRow("approved")], rowCount: 1 };
      }
      throw new Error(`unexpected-sql:${sql.slice(0, 80)}`);
    });
    const store = createPostgresDelegatedDeliveryStore(serialDatabase(query));
    const input = {
      requestId: "ddr_1234567890123456",
      sessionTokenHash: "session-hash",
      codeExpiresAt: new Date("2026-08-22T00:05:00.000Z"),
      now
    };

    const results = await Promise.allSettled([
      store.approveRequest({ ...input, codeHash: "a".repeat(64) }),
      store.approveRequest({ ...input, codeHash: "b".repeat(64) })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(codeInserts).toBe(1);
    expect(auditInserts).toBe(1);
  });

  it("issues a grant after approval even though approval already erased return state", async () => {
    const sqlCalls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes("insert into slack_delivery_dpop_replay")) return { rows: [], rowCount: 1 };
      if (sql.includes("from slack_delivery_authorization_codes c") && sql.includes("for update of c, r, sc, cred")) {
        expect(sql).toContain("sc.prism_user_id = r.approved_prism_user_id");
        expect(sql).toContain("sc.team_id = r.approved_slack_team_id");
        expect(sql).toContain("sc.authed_user_id = r.approved_slack_user_id");
        expect(sql).toContain("cred.kind = 'user'");
        expect(sql).toContain("sc.status = 'healthy'");
        return {
          rows: [{
            request_id: "ddr_1234567890123456",
            client_id: "shg-playtest-delegation",
            external_job_id: "job-123",
            revision: 1,
            prism_user_id: "prism-user-123",
            slack_user_id: "U0123456789",
            team_id: "T123ABC",
            channel_id: "C123ABC",
            payload_sha256: "a".repeat(64),
            not_before: new Date("2026-08-22T00:05:00.000Z"),
            expires_at: deliveryExpiresAt,
            slack_connection_id: "connection-1",
            connection_id_snapshot: "connection-1",
            code_hash: "c".repeat(64),
            user_scopes: "search:read,chat:write"
          }],
          rowCount: 1
        };
      }
      if (sql.includes("update slack_delivery_authorization_codes")) return { rows: [], rowCount: 1 };
      if (sql.includes("insert into slack_delivery_grants")) return { rows: [], rowCount: 1 };
      if (sql.includes("insert into prism_activity_audit")) return { rows: [auditRow("issued")], rowCount: 1 };
      throw new Error(`unexpected-sql:${sql.slice(0, 80)}`);
    });
    const store = createPostgresDelegatedDeliveryStore(fakeDatabase(query));

    await expect(store.exchangeCodeForGrant({
      codeHash: "c".repeat(64),
      clientId: "shg-playtest-delegation",
      redirectUri: "https://playtest.example/api/announcements/delegation/callback",
      codeChallenge: "p".repeat(43),
      proofReplay: { jkt: "j".repeat(43), jtiHash: "f".repeat(64), expiresAt: new Date("2026-08-22T00:02:00.000Z") },
      grantId: "ddg_1234567890123456",
      grantHash: "g".repeat(64),
      pepperId: "grant-pepper-v1",
      statusRetentionMs: limits.statusRetentionMs,
      now
    })).resolves.toMatchObject({
      grantId: "ddg_1234567890123456",
      prismUserId: "prism-user-123",
      slackUserId: "U0123456789"
    });

    expect(sqlCalls.some((sql) => sql.includes("from slack_delivery_delegation_requests where id = $1"))).toBe(false);
  });
});

function requestRow() {
  return {
    id: "ddr_1234567890123456",
    client_id: "shg-playtest-delegation",
    external_job_id: "job-123",
    revision: 1,
    idempotency_key: "job-123:1",
    callback_uri: "https://playtest.example/api/announcements/delegation/callback",
    expected_prism_user_id: "prism-user-123",
    action: "chat.postMessage",
    execution_mode: "user",
    team_id: "T123ABC",
    channel_id: "C123ABC",
    payload_envelope: envelope,
    payload_sha256: "a".repeat(64),
    return_state_envelope: envelope,
    code_challenge: "c".repeat(43),
    dpop_jkt: "j".repeat(43),
    not_before: new Date("2026-08-22T00:05:00.000Z"),
    approval_expires_at: approvalExpiresAt,
    delivery_expires_at: deliveryExpiresAt,
    state: "pending"
  };
}

function auditRow(status: string) {
  return {
    id: "audit-1", prism_user_id: null, slack_connection_id: null,
    token_profile_id: null, token_profile_name: null, slack_user_id: null,
    slack_team_id: null, slack_enterprise_id: null,
    activity_type: status === "approved"
      ? "delegated_delivery_approved"
      : status === "issued"
        ? "delegated_delivery_grant_issued"
        : "delegated_delivery_requested",
    endpoint: null, slack_method: "chat.postMessage", action_category: "messages.write",
    surface: "public_channel", object_type: "channel", object_id: "C123ABC",
    execution_mode: "user", status, error_class: null, http_status: null,
    request_id: "ddr_1234567890123456", upstream_called: false,
    occurred_at: now, retention_expires_at: new Date("2026-11-20T00:00:00.000Z"),
    admin_actor_prism_user_id: null, admin_actor_slack_user_id: null,
    admin_actor_slack_display_name: null, admin_reason: null
  };
}

function fakeDatabase(query: unknown): Database {
  const database: Database = {
    query: query as Database["query"],
    transaction: async (callback) => callback(database)
  };
  return database;
}

function serialDatabase(query: unknown): Database {
  let queue: Promise<unknown> = Promise.resolve();
  const database: Database = {
    query: query as Database["query"],
    transaction: async <T>(callback: (database: Database) => Promise<T>): Promise<T> => {
      const run = queue.then(() => callback(database));
      queue = run.then(() => undefined, () => undefined);
      return run;
    }
  };
  return database;
}
