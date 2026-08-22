import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import {
  SETUP_EXCHANGE_GLOBAL_CIRCUIT_BREAKER_MAX_ATTEMPTS,
  SETUP_EXCHANGE_RATE_LIMIT_MAX_ATTEMPTS_PER_SOURCE,
  SETUP_EXCHANGE_RATE_LIMIT_WINDOW_MS,
  SetupBootstrapRateLimitedError,
  SetupBootstrapRecoveryRequiredError,
  SetupBootstrapStoreUnavailableError
} from "./bootstrap";
import { createPostgresSetupBootstrapStore } from "./bootstrap-postgres-store";

describe("Postgres setup bootstrap store", () => {
  it("revokes an earlier unused capability and inserts only the new hash", async () => {
    const queries: QueryCapture[] = [];
    const database = recordingDatabase(queries, ({ sql, params }) => {
      if (sql.includes("as setup_claimed")) return rows([{ setup_claimed: false }]);
      if (sql.includes("insert into prism_setup_bootstrap_tokens")) {
        return rows([{
          id: params?.[0], token_hash: params?.[1], purpose: params?.[2], recovery: params?.[3],
          created_at: params?.[4], expires_at: params?.[5]
        }]);
      }
      return rows([]);
    });
    const store = createPostgresSetupBootstrapStore(database);
    const tokenHash = "a".repeat(64);

    await store.mintCapability({
      id: "bootstrap_1", tokenHash, purpose: "initial_slack_configuration", recovery: false,
      createdAt: new Date("2026-08-23T01:00:00.000Z"), expiresAt: new Date("2026-08-23T01:15:00.000Z")
    });

    expect(queries.some(({ sql }) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("update prism_setup_bootstrap_tokens") && sql.includes("revoked_at is null"))).toBe(true);
    expect(queries.some(({ sql, params }) => sql.includes("insert into prism_setup_bootstrap_tokens") && params?.includes(tokenHash))).toBe(true);
  });

  it("requires explicit recovery after configuration activation or an admin claim", async () => {
    const database = recordingDatabase([], ({ sql }) => sql.includes("as setup_claimed") ? rows([{ setup_claimed: true }]) : rows([]));
    const store = createPostgresSetupBootstrapStore(database);

    await expect(store.mintCapability({
      id: "bootstrap_1", tokenHash: "b".repeat(64), purpose: "initial_slack_configuration", recovery: false,
      createdAt: new Date("2026-08-23T01:00:00.000Z"), expiresAt: new Date("2026-08-23T01:15:00.000Z")
    })).rejects.toBeInstanceOf(SetupBootstrapRecoveryRequiredError);
  });

  it("makes recovery explicit and revokes active setup artifacts before minting", async () => {
    const queries: QueryCapture[] = [];
    const database = recordingDatabase(queries, ({ sql, params }) => {
      if (sql.includes("as setup_claimed")) return rows([{ setup_claimed: true }]);
      if (sql.includes("insert into prism_setup_bootstrap_tokens")) {
        return rows([{ id: params?.[0], token_hash: params?.[1], purpose: params?.[2], recovery: params?.[3], created_at: params?.[4], expires_at: params?.[5] }]);
      }
      return rows([]);
    });
    const store = createPostgresSetupBootstrapStore(database);

    await store.mintCapability({
      id: "bootstrap_recovery", tokenHash: "c".repeat(64), purpose: "initial_slack_configuration", recovery: true,
      createdAt: new Date("2026-08-23T01:00:00.000Z"), expiresAt: new Date("2026-08-23T01:15:00.000Z")
    });

    expect(queries.some(({ sql }) => sql.includes("update prism_setup_sessions") && sql.includes("revoked_at"))).toBe(true);
    expect(queries.some(({ sql, params }) => sql.includes("insert into prism_setup_bootstrap_tokens") && params?.includes(true))).toBe(true);
  });

  it("consumes a capability once and inserts the setup session in the same transaction", async () => {
    const queries: QueryCapture[] = [];
    const database = recordingDatabase(queries, ({ sql, params }) => {
      if (sql.includes("update prism_setup_bootstrap_tokens") && sql.includes("returning id")) {
        return rows([{ id: "bootstrap_1", purpose: "initial_slack_configuration", recovery: false }]);
      }
      if (sql.includes("insert into prism_setup_sessions")) {
        return rows([{ id: params?.[0], bootstrap_token_id: params?.[2], purpose: params?.[3], expires_at: params?.[5], recovery: false, pending_configuration_version_id: null }]);
      }
      return rows([]);
    });
    const store = createPostgresSetupBootstrapStore(database);

    const result = await store.consumeCapability({
      tokenHash: "d".repeat(64), setupSessionId: "session_1", sessionTokenHash: "e".repeat(64),
      purpose: "initial_slack_configuration", requestId: "request_1", now: new Date("2026-08-23T01:00:00.000Z"),
      expiresAt: new Date("2026-08-23T01:30:00.000Z"), sourceRateLimitBucketKey: null
    });

    expect(result?.id).toBe("session_1");
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(queries.some(({ sql }) => sql.includes("used_at is null") && sql.includes("expires_at >"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("insert into prism_setup_sessions"))).toBe(true);
  });

  it("returns null without creating a session for wrong, expired, revoked, or already-used hashes", async () => {
    const queries: QueryCapture[] = [];
    const database = recordingDatabase(queries, () => rows([]));
    const store = createPostgresSetupBootstrapStore(database);

    await expect(store.consumeCapability({
      tokenHash: "f".repeat(64), setupSessionId: "session_1", sessionTokenHash: "0".repeat(64),
      purpose: "initial_slack_configuration", requestId: "request_1", now: new Date("2026-08-23T01:00:00.000Z"),
      expiresAt: new Date("2026-08-23T01:30:00.000Z"), sourceRateLimitBucketKey: null
    })).resolves.toBeNull();
    expect(queries.some(({ sql }) => sql.includes("insert into prism_setup_sessions"))).toBe(false);
  });

  it("has exactly one winner when two exchanges race for the same capability", async () => {
    let capabilityIsLive = true;
    let insertedSessions = 0;
    const database = recordingDatabase([], ({ sql, params }) => {
      if (sql.includes("update prism_setup_bootstrap_tokens") && sql.includes("returning id")) {
        if (!capabilityIsLive) return rows([]);
        capabilityIsLive = false;
        return rows([{ id: "bootstrap_1", purpose: "initial_slack_configuration", recovery: false }]);
      }
      if (sql.includes("insert into prism_setup_sessions")) {
        insertedSessions += 1;
        return rows([{ id: params?.[0], bootstrap_token_id: "bootstrap_1", purpose: "initial_slack_configuration",
          recovery: false, expires_at: params?.[5], pending_configuration_version_id: null }]);
      }
      return rows([]);
    });
    const store = createPostgresSetupBootstrapStore(database);
    const common = {
      tokenHash: "2".repeat(64), purpose: "initial_slack_configuration" as const,
      requestId: "request_1", now: new Date("2026-08-23T01:00:00.000Z"),
      expiresAt: new Date("2026-08-23T01:30:00.000Z"), sourceRateLimitBucketKey: null
    };

    const results = await Promise.all([
      store.consumeCapability({ ...common, setupSessionId: "session_1", sessionTokenHash: "3".repeat(64) }),
      store.consumeCapability({ ...common, setupSessionId: "session_2", sessionTokenHash: "4".repeat(64) })
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(insertedSessions).toBe(1);
  });

  it("uses a high-volume global circuit breaker without a low unattributed-source bucket", async () => {
    let attempts = SETUP_EXCHANGE_GLOBAL_CIRCUIT_BREAKER_MAX_ATTEMPTS - 1;
    let tokenLookups = 0;
    const bucketKeys: unknown[] = [];
    const now = new Date("2026-08-23T01:00:00.000Z");
    const database = recordingDatabase([], ({ sql, params }) => {
      if (sql.includes("insert into prism_setup_rate_limit_buckets")) {
        bucketKeys.push(params?.[0]);
        attempts += 1;
        return rows([{ attempt_count: attempts, window_started_at: now }]);
      }
      if (sql.includes("update prism_setup_bootstrap_tokens") && sql.includes("returning id")) {
        tokenLookups += 1;
        return rows([]);
      }
      return rows([]);
    });
    const store = createPostgresSetupBootstrapStore(database);
    const common = {
      tokenHash: "5".repeat(64), purpose: "initial_slack_configuration" as const,
      requestId: "request_1", now, expiresAt: new Date(now.getTime() + 30 * 60_000),
      sourceRateLimitBucketKey: null
    };

    const settled = await Promise.allSettled([
      store.consumeCapability({ ...common, setupSessionId: "session_1", sessionTokenHash: "6".repeat(64) }),
      store.consumeCapability({ ...common, setupSessionId: "session_2", sessionTokenHash: "7".repeat(64) })
    ]);

    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(SetupBootstrapRateLimitedError) });
    expect(tokenLookups).toBe(1);
    expect(new Set(bucketKeys)).toEqual(new Set(["global:initial_slack_configuration"]));
  });

  it("caps repeated attempts from one attributed source without storing its raw address", async () => {
    const rawAddress = "192.0.2.44";
    const sourceBucket = `source:${"a".repeat(64)}`;
    let sourceAttempts = SETUP_EXCHANGE_RATE_LIMIT_MAX_ATTEMPTS_PER_SOURCE - 1;
    let tokenLookups = 0;
    const queries: QueryCapture[] = [];
    const now = new Date("2026-08-23T01:00:00.000Z");
    const database = recordingDatabase(queries, ({ sql, params }) => {
      if (sql.includes("insert into prism_setup_rate_limit_buckets")) {
        const bucketKey = params?.[0];
        if (bucketKey === sourceBucket) {
          sourceAttempts += 1;
          return rows([{ attempt_count: sourceAttempts, window_started_at: now }]);
        }
        return rows([{ attempt_count: 1, window_started_at: now }]);
      }
      if (sql.includes("update prism_setup_bootstrap_tokens") && sql.includes("returning id")) {
        tokenLookups += 1;
        return rows([]);
      }
      return rows([]);
    });
    const store = createPostgresSetupBootstrapStore(database);
    const common = {
      tokenHash: "5".repeat(64), purpose: "initial_slack_configuration" as const,
      requestId: "request_1", now, expiresAt: new Date(now.getTime() + 30 * 60_000),
      sourceRateLimitBucketKey: sourceBucket
    };

    await expect(store.consumeCapability({ ...common, setupSessionId: "session_1", sessionTokenHash: "6".repeat(64) })).resolves.toBeNull();
    await expect(store.consumeCapability({ ...common, setupSessionId: "session_2", sessionTokenHash: "7".repeat(64) })).rejects.toBeInstanceOf(SetupBootstrapRateLimitedError);

    expect(tokenLookups).toBe(1);
    expect(JSON.stringify(queries)).not.toContain(rawAddress);
    expect(queries.filter(({ params }) => params?.[0] === sourceBucket)).toHaveLength(2);
  });

  it("rejects a non-HMAC source bucket before any database counter or capability lookup", async () => {
    const queries: QueryCapture[] = [];
    const database = recordingDatabase(queries, () => rows([]));
    const store = createPostgresSetupBootstrapStore(database);
    const now = new Date("2026-08-23T01:00:00.000Z");

    await expect(store.consumeCapability({
      tokenHash: "5".repeat(64), setupSessionId: "session_raw", sessionTokenHash: "6".repeat(64),
      purpose: "initial_slack_configuration", requestId: "request_raw", now,
      expiresAt: new Date(now.getTime() + 30 * 60_000), sourceRateLimitBucketKey: "192.0.2.44"
    })).rejects.toBeInstanceOf(SetupBootstrapStoreUnavailableError);

    expect(queries).toHaveLength(0);
  });

  it("maintains independent per-source buckets", async () => {
    const sourceOne = `source:${"b".repeat(64)}`;
    const sourceTwo = `source:${"c".repeat(64)}`;
    const counts = new Map<string, number>([
      [sourceOne, SETUP_EXCHANGE_RATE_LIMIT_MAX_ATTEMPTS_PER_SOURCE],
      [sourceTwo, 0]
    ]);
    let tokenLookups = 0;
    const now = new Date("2026-08-23T01:00:00.000Z");
    const database = recordingDatabase([], ({ sql, params }) => {
      if (sql.includes("insert into prism_setup_rate_limit_buckets")) {
        const key = String(params?.[0]);
        if (key.startsWith("source:")) {
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return rows([{ attempt_count: count, window_started_at: now }]);
        }
        return rows([{ attempt_count: 1, window_started_at: now }]);
      }
      if (sql.includes("update prism_setup_bootstrap_tokens") && sql.includes("returning id")) {
        tokenLookups += 1;
        return rows([]);
      }
      return rows([]);
    });
    const store = createPostgresSetupBootstrapStore(database);
    const common = {
      tokenHash: "8".repeat(64), purpose: "initial_slack_configuration" as const,
      requestId: "request_distinct", now, expiresAt: new Date(now.getTime() + 30 * 60_000)
    };

    await expect(store.consumeCapability({ ...common, setupSessionId: "session_1", sessionTokenHash: "9".repeat(64), sourceRateLimitBucketKey: sourceOne })).rejects.toBeInstanceOf(SetupBootstrapRateLimitedError);
    await expect(store.consumeCapability({ ...common, setupSessionId: "session_2", sessionTokenHash: "0".repeat(64), sourceRateLimitBucketKey: sourceTwo })).resolves.toBeNull();

    expect(tokenLookups).toBe(1);
  });

  it("resets the global attempt bucket after its fixed window", async () => {
    const oldWindow = new Date("2026-08-23T00:58:00.000Z");
    const now = new Date(oldWindow.getTime() + SETUP_EXCHANGE_RATE_LIMIT_WINDOW_MS + 1);
    const queries: QueryCapture[] = [];
    const database = recordingDatabase(queries, ({ sql }) => {
      if (sql.includes("insert into prism_setup_rate_limit_buckets")) {
        return rows([{ attempt_count: 1, window_started_at: now }]);
      }
      return rows([]);
    });
    const store = createPostgresSetupBootstrapStore(database);

    await expect(store.consumeCapability({
      tokenHash: "8".repeat(64), setupSessionId: "session_1", sessionTokenHash: "9".repeat(64),
      purpose: "initial_slack_configuration", requestId: "request_1", now,
      expiresAt: new Date(now.getTime() + 30 * 60_000), sourceRateLimitBucketKey: null
    })).resolves.toBeNull();

    const rateQuery = queries.find(({ sql }) => sql.includes("insert into prism_setup_rate_limit_buckets"));
    expect(rateQuery?.params).toContain(SETUP_EXCHANGE_RATE_LIMIT_WINDOW_MS);
    expect(rateQuery?.sql).toContain("attempt_count = case");
    expect(queries.some(({ sql }) => sql.includes("update prism_setup_bootstrap_tokens") && sql.includes("returning id"))).toBe(true);
  });

  it("resolves only a live unclaimed setup session and includes its pending configuration association", async () => {
    const database = recordingDatabase([], ({ sql }) => sql.includes("from prism_setup_sessions")
      ? rows([{ id: "session_1", bootstrap_token_id: "bootstrap_1", purpose: "initial_slack_configuration", recovery: false,
          expires_at: new Date("2026-08-23T01:30:00.000Z"), pending_configuration_version_id: "configuration_2" }])
      : rows([]));
    const store = createPostgresSetupBootstrapStore(database);

    await expect(store.resolveSession({ sessionTokenHash: "1".repeat(64), now: new Date("2026-08-23T01:00:00.000Z") }))
      .resolves.toMatchObject({ id: "session_1", pendingConfigurationVersionId: "configuration_2" });
  });

  it("claims the bound session and configuration-admin role transactionally", async () => {
    const queries: QueryCapture[] = [];
    const database = recordingDatabase(queries, ({ sql }) => {
      if (sql.includes("from prism_setup_sessions s") && sql.includes("for update")) return rows([{ id: "session_1", recovery: false, configuration_version_id: "configuration_1" }]);
      if (sql.includes("from prism_configuration_admins") && sql.includes("revoked_at is null")) return rows([]);
      if (sql.includes("update prism_setup_sessions") && sql.includes("returning id")) return rows([{ id: "session_1" }]);
      return rows([]);
    });
    const store = createPostgresSetupBootstrapStore(database);

    await expect(store.claimSessionAndConfigurationAdmin({
      setupSessionId: "session_1", configurationVersionId: "configuration_1", prismUserId: "prism_user_1",
      now: new Date("2026-08-23T01:10:00.000Z")
    })).resolves.toEqual({ recovery: false });

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(queries.some(({ sql }) => sql.includes("insert into prism_configuration_admins"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("update prism_setup_sessions") && sql.includes("claimed_by_prism_user_id"))).toBe(true);
  });

  it("uses an explicit recovery session to revoke prior configuration admins before claiming", async () => {
    const queries: QueryCapture[] = [];
    const database = recordingDatabase(queries, ({ sql }) => {
      if (sql.includes("from prism_setup_sessions s") && sql.includes("for update")) {
        return rows([{ id: "session_recovery", recovery: true, configuration_version_id: "configuration_2" }]);
      }
      if (sql.includes("update prism_setup_sessions") && sql.includes("returning id")) return rows([{ id: "session_recovery" }]);
      return rows([]);
    });
    const store = createPostgresSetupBootstrapStore(database);

    await expect(store.claimSessionAndConfigurationAdmin({
      setupSessionId: "session_recovery", configurationVersionId: "configuration_2", prismUserId: "replacement_admin",
      now: new Date("2026-08-23T01:10:00.000Z")
    })).resolves.toEqual({ recovery: true });

    const revokeIndex = queries.findIndex(({ sql }) => sql.includes("update prism_configuration_admins") && sql.includes("revoked_at"));
    const claimIndex = queries.findIndex(({ sql }) => sql.includes("insert into prism_configuration_admins"));
    expect(revokeIndex).toBeGreaterThan(-1);
    expect(claimIndex).toBeGreaterThan(revokeIndex);
  });
});

type QueryCapture = { sql: string; params: unknown[] | undefined };

function recordingDatabase(captures: QueryCapture[], resultFor: (query: QueryCapture) => { rows: any[]; rowCount: number }): Database {
  const database: Database = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const capture = { sql: sql.toLowerCase(), params };
      captures.push(capture);
      const result = resultFor(capture);
      if (capture.sql.includes("insert into prism_setup_rate_limit_buckets") && result.rows.length === 0) {
        return rows([{ attempt_count: 1, window_started_at: params?.[1] }]);
      }
      return result;
    }),
    transaction: vi.fn(async (callback) => callback(database))
  };
  return database;
}

function rows(values: any[]) {
  return { rows: values, rowCount: values.length };
}
