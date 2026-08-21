import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { hashSecret } from "../slack/oauth-flow";
import { createPostgresOidcStore } from "./postgres-store";

describe("Postgres OIDC store", () => {
  it("persists and loads pending requests without changing validated fields", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [{ bucket_key: params?.[0] }], rowCount: 1 };
      }
      if (sql.includes("client_outstanding")) {
        return { rows: [{ client_outstanding: 0, source_outstanding: 0, client_retry_at: null, source_retry_at: null }], rowCount: 1 };
      }
      if (sql.includes("insert into oidc_authorization_requests")) {
        expect(params).toEqual([
          "request-1", "shg-playtest", "http://localhost:3847/api/auth/callback", "state-1", "nonce-1",
          "openid profile", "challenge-1", "S256", new Date("2026-08-21T00:05:00.000Z"),
          hashSecret("oidc-authorize:source:shg-playtest:192.0.2.10")
        ]);
        return { rows: [], rowCount: 1 };
      }
      expect(params).toEqual(["request-1", new Date("2026-08-21T00:00:00.000Z")]);
      return {
        rows: [{ id: "request-1", client_id: "shg-playtest", redirect_uri: "http://localhost:3847/api/auth/callback", state: "state-1", nonce: "nonce-1", scope: "openid profile", code_challenge: "challenge-1", code_challenge_method: "S256", expires_at: new Date("2026-08-21T00:05:00.000Z") }],
        rowCount: 1
      };
    });
    const store = createPostgresOidcStore(fakeDatabase(query));
    const input = {
      requestId: "request-1", clientId: "shg-playtest", redirectUri: "http://localhost:3847/api/auth/callback",
      state: "state-1", nonce: "nonce-1", scope: "openid profile", codeChallenge: "challenge-1",
      expiresAt: new Date("2026-08-21T00:05:00.000Z"), sourceIdentifier: "192.0.2.10",
      now: new Date("2026-08-21T00:00:00.000Z"), maxOutstandingPerSource: 10, maxOutstandingPerClient: 500
    };

    await expect(store.createPendingAuthorizationRequest(input)).resolves.toEqual({ kind: "created", requestId: "request-1" });
    await expect(store.loadPendingAuthorizationRequest({ requestId: input.requestId, now: new Date("2026-08-21T00:00:00.000Z") })).resolves.toEqual({
      requestId: "request-1", clientId: "shg-playtest", redirectUri: "http://localhost:3847/api/auth/callback", state: "state-1", nonce: "nonce-1", scope: "openid profile", codeChallenge: "challenge-1", codeChallengeMethod: "S256", expiresAt: new Date("2026-08-21T00:05:00.000Z")
    });
  });

  it("resolves only an unexpired session with a healthy Slack connection", async () => {
    const now = new Date("2026-08-21T00:00:00.000Z");
    const query = vi.fn(async () => ({ rows: [{ prism_user_id: "user-1", slack_connection_id: "connection-1", slack_user_id: "U1", slack_user_display_name: "Ada", team_id: "T1", team_name: "Workspace", enterprise_id: null, enterprise_name: null, auth_time: now }], rowCount: 1 }));
    const store = createPostgresOidcStore(fakeDatabase(query));

    await expect(store.resolveEligiblePrismSessionIdentity({ sessionToken: "session-token", now })).resolves.toEqual({ prismUserId: "user-1", slackConnectionId: "connection-1", slackUserId: "U1", slackUserDisplayName: "Ada", teamId: "T1", teamName: "Workspace", enterpriseId: null, enterpriseName: null, authTime: now });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("c.status = 'healthy'"), [hashSecret("session-token"), now]);
  });

  it("uses shared Postgres client/source buckets and performs bounded expiry cleanup", async () => {
    const now = new Date("2026-08-21T00:00:00.000Z");
    const buckets = new Map<string, { request_count: number; window_reset_at: Date }>();
    const cleanupSql: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("with expired_rows")) {
        cleanupSql.push(sql);
        expect(params).toEqual([now, 25]);
        expect(sql).toContain("limit $2");
        return { rows: [], rowCount: 0 };
      }
      const key = params?.[0] as string;
      if (sql.includes("insert into oidc_authorization_rate_limits")) {
        if (buckets.has(key)) return { rows: [], rowCount: 0 };
        buckets.set(key, { request_count: 1, window_reset_at: params?.[2] as Date });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("select request_count")) {
        const bucket = buckets.get(key);
        return { rows: bucket ? [bucket] : [], rowCount: bucket ? 1 : 0 };
      }
      if (sql.includes("request_count = request_count + 1")) {
        const bucket = buckets.get(key)!;
        bucket.request_count += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = createPostgresOidcStore(fakeDatabase(query));
    const input = {
      clientId: "shg-playtest", sourceIdentifier: "192.0.2.10", now,
      windowMs: 60_000, maxRequestsPerSource: 5, maxRequestsPerClient: 1, cleanupBatchSize: 25
    };

    await expect(store.consumeAuthorizationRequestPermit(input)).resolves.toEqual({ kind: "allowed" });
    await expect(store.consumeAuthorizationRequestPermit(input)).resolves.toEqual({
      kind: "limited", retryAfterSeconds: 60
    });

    expect(cleanupSql).toHaveLength(10);
    for (const table of [
      "oidc_access_tokens", "oidc_authorization_codes", "slack_oauth_states",
      "oidc_authorization_requests", "oidc_authorization_rate_limits"
    ]) {
      expect(cleanupSql.some((sql) => sql.includes(`delete from ${table}`))).toBe(true);
    }
  });

  it("enforces outstanding pending caps before insert across concurrent processes", async () => {
    const sqlCalls: string[] = [];
    const lockedKeys: unknown[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) {
        lockedKeys.push(params?.[0]);
        return { rows: [{ bucket_key: params?.[0] }], rowCount: 1 };
      }
      if (sql.includes("client_outstanding")) {
        return {
          rows: [{ client_outstanding: 500, source_outstanding: 10, client_retry_at: new Date("2026-08-21T00:03:00.000Z"), source_retry_at: new Date("2026-08-21T00:02:00.000Z") }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(createPostgresOidcStore(fakeDatabase(query)).createPendingAuthorizationRequest({
      requestId: "request-1", clientId: "shg-playtest", redirectUri: "http://localhost:3847/api/auth/callback",
      state: "state-1", nonce: "nonce-1", scope: "openid", codeChallenge: "challenge-1",
      expiresAt: new Date("2026-08-21T00:10:00.000Z"), sourceIdentifier: "192.0.2.10",
      now: new Date("2026-08-21T00:00:00.000Z"), maxOutstandingPerSource: 10, maxOutstandingPerClient: 500
    })).resolves.toEqual({ kind: "limited", retryAfterSeconds: 180 });
    expect(lockedKeys).toEqual([
      hashSecret("oidc-authorize:client:shg-playtest"),
      hashSecret("oidc-authorize:source:shg-playtest:192.0.2.10")
    ]);
    expect(sqlCalls.some((sql) => sql.includes("insert into oidc_authorization_requests"))).toBe(false);
  });

  it("uses the client cap without turning unattributed direct traffic into a ten-request global cap", async () => {
    const lockedKeys: unknown[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        lockedKeys.push(params?.[0]);
        return { rows: [{ bucket_key: params?.[0] }], rowCount: 1 };
      }
      if (sql.includes("client_outstanding")) {
        return { rows: [{ client_outstanding: 9, source_outstanding: 9, client_retry_at: null, source_retry_at: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(createPostgresOidcStore(fakeDatabase(query)).createPendingAuthorizationRequest({
      requestId: "request-1", clientId: "shg-playtest", redirectUri: "http://localhost:3847/api/auth/callback",
      state: "state-1", nonce: "nonce-1", scope: "openid", codeChallenge: "challenge-1",
      expiresAt: new Date("2026-08-21T00:10:00.000Z"), sourceIdentifier: "unattributed",
      now: new Date("2026-08-21T00:00:00.000Z"), maxOutstandingPerSource: 1, maxOutstandingPerClient: 500
    })).resolves.toEqual({ kind: "created", requestId: "request-1" });
    expect(lockedKeys).toEqual([hashSecret("oidc-authorize:client:shg-playtest")]);
  });

  it("atomically consumes a code with exact client, redirect, verifier and expiry", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("update oidc_authorization_codes");
      expect(sql).toContain("used_at is null");
      return { rows: [{ prism_user_id: "user-1", slack_connection_id: "connection-1", client_id: "shg-playtest", redirect_uri: "http://localhost:3847/api/auth/callback", nonce: "nonce-1", scope: "openid", auth_time: new Date("2026-08-21T00:00:00.000Z") }], rowCount: 1 };
    });
    const store = createPostgresOidcStore(fakeDatabase(query));

    await expect(store.consumeAuthorizationCode({ code: "code-1", clientId: "shg-playtest", redirectUri: "http://localhost:3847/api/auth/callback", codeVerifier: "v".repeat(43), now: new Date("2026-08-21T00:01:00.000Z") })).resolves.toMatchObject({ prismUserId: "user-1" });
  });

  it("consumes a pending request and inserts its code in one transaction", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("with consumed_request")) {
        expect(params).toEqual([
          "request-1", new Date("2026-08-21T00:00:00.000Z"), expect.any(String),
          "user-1", "connection-1", new Date("2026-08-21T00:00:00.000Z"), new Date("2026-08-21T00:05:00.000Z")
        ]);
        return { rows: [{ code_hash: "opaque-hash" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const transaction = vi.fn(async <T>(callback: (database: Database) => Promise<T>): Promise<T> =>
      callback({ query: query as Database["query"], transaction: transaction as unknown as Database["transaction"] })
    );
    const database: Database = { query: query as Database["query"], transaction: transaction as unknown as Database["transaction"] };

    await expect(createPostgresOidcStore(database).issueAuthorizationCode({
      // These caller fields must never override the validated pending record.
      requestId: "request-1", clientId: "attacker-client", prismUserId: "user-1", slackConnectionId: "connection-1",
      redirectUri: "https://attacker.invalid/callback", nonce: "attacker-nonce", scope: "openid email",
      codeChallenge: "attacker-challenge", authTime: new Date("2026-08-21T00:00:00.000Z"), expiresAt: new Date("2026-08-21T00:05:00.000Z"),
      now: new Date("2026-08-21T00:00:00.000Z")
    })).resolves.toEqual({ code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });

    expect(transaction).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("with consumed_request");
    expect(calls[0]).toContain("p.client_id");
    expect(calls[0]).toContain("p.redirect_uri");
    expect(calls[0]).toContain("p.code_challenge");
  });

  it("atomically consumes an exact, live code and persists the access token", async () => {
    const now = new Date("2026-08-21T00:01:00.000Z");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("with consumed_code");
      expect(sql).toContain("c.status = 'healthy'");
      expect(sql).toContain("insert into oidc_access_tokens");
      expect(params).toEqual([
        hashSecret("code-1"), "shg-playtest", "http://localhost:3847/api/auth/callback",
        pkceChallenge("v".repeat(43)), now, expect.any(String), new Date("2026-08-21T00:06:00.000Z")
      ]);
      return { rows: [{ prism_user_id: "user-1", slack_connection_id: "connection-1", client_id: "shg-playtest", redirect_uri: "http://localhost:3847/api/auth/callback", nonce: "nonce-1", scope: "openid", code_challenge: pkceChallenge("v".repeat(43)), code_challenge_method: "S256", auth_time: now }], rowCount: 1 };
    });
    const store = createPostgresOidcStore(fakeDatabase(query));

    await expect(store.exchangeAuthorizationCode({
      code: "code-1", clientId: "shg-playtest", redirectUri: "http://localhost:3847/api/auth/callback",
      codeVerifier: "v".repeat(43), now, accessTokenExpiresAt: new Date("2026-08-21T00:06:00.000Z")
    })).resolves.toMatchObject({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), authorizationCode: { prismUserId: "user-1" } });
  });

  it("rejects a second pending-request completion without issuing another code", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = createPostgresOidcStore(fakeDatabase(query));

    await expect(store.issueAuthorizationCode({
      requestId: "already-consumed", clientId: "ignored", prismUserId: "user-1", slackConnectionId: "connection-1",
      redirectUri: "https://ignored.invalid", nonce: "ignored", scope: "openid", codeChallenge: "ignored",
      authTime: new Date("2026-08-21T00:00:00.000Z"), expiresAt: new Date("2026-08-21T00:05:00.000Z"), now: new Date("2026-08-21T00:01:00.000Z")
    })).rejects.toThrow("oidc-authorization-request-unavailable");
    expect(query).toHaveBeenCalledOnce();
  });

  it("resolves only a live, non-revoked access token", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("revoked_at is null");
      expect(sql).toContain("expires_at > $2");
      expect(sql).toContain("c.status = 'healthy'");
      expect(sql).toContain("c.prism_user_id = t.prism_user_id");
      return { rows: [{ prism_user_id: "user-1", slack_connection_id: "connection-1", client_id: "shg-playtest", scope: "openid", slack_user_id: "U1", slack_user_display_name: "Ada", team_id: "T1", team_name: "Workspace", enterprise_id: null, enterprise_name: null }], rowCount: 1 };
    });
    await expect(createPostgresOidcStore(fakeDatabase(query)).resolveAccessToken({ token: "access-token", now: new Date("2026-08-21T00:00:00.000Z") })).resolves.toEqual({ prismUserId: "user-1", slackConnectionId: "connection-1", clientId: "shg-playtest", scope: "openid", slackUserId: "U1", slackUserDisplayName: "Ada", teamId: "T1", teamName: "Workspace", enterpriseId: null, enterpriseName: null });
    expect(query).toHaveBeenCalledWith(expect.any(String), [hashSecret("access-token"), new Date("2026-08-21T00:00:00.000Z")]);
  });

  it("rejects an access token when its Slack connection belongs to another Prism user", async () => {
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes("c.prism_user_id = t.prism_user_id")) {
        return {
          rows: [{ prism_user_id: "user-1", slack_connection_id: "connection-2", client_id: "shg-playtest", scope: "openid" }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(createPostgresOidcStore(fakeDatabase(query)).resolveAccessToken({
      token: "access-token", now: new Date("2026-08-21T00:00:00.000Z")
    })).resolves.toBeNull();
  });
});

function fakeDatabase(query: unknown): Database {
  return { query: query as Database["query"], transaction: async (callback) => callback(fakeDatabase(query)) };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
