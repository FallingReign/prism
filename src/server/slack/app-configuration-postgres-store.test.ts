import { describe, expect, it, vi } from "vitest";

import { createLocalAesGcmCredentialCipher } from "../credentials/encryption";
import type { Database, QueryResult } from "../db";
import {
  SlackAppConfigurationStoreError,
  createPostgresSlackAppConfigurationStore,
  slackAppConfigurationSecretAad,
  slackSocketAppTokenAad
} from "./app-configuration-postgres-store";

const testKey = Buffer.alloc(32, 9).toString("base64");

describe("Postgres Slack app configuration store", () => {
  it("creates an encrypted immutable pending candidate and metadata-only audit atomically", async () => {
    const secret = "client-secret-canary-never-in-sql";
    const appToken = "xapp-1-A1234567890-app-token-canary";
    const cipher = createLocalAesGcmCredentialCipher({ key: testKey, keyId: "test-key" });
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const tx = fakeDatabase(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const serialized = JSON.stringify(params);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(appToken);
      if (sql.includes("from prism_setup_sessions")) {
        return result([{ id: "setup-session" }]);
      }
      if (sql.includes("from prism_slack_app_configuration_versions") && sql.includes("for update")) {
        return result([]);
      }
      if (sql.includes("insert into prism_slack_app_configuration_versions")) {
        expect(params[0]).toBe("configuration-id");
        expect(typeof params[2]).toBe("string");
        expect(params[3]).toHaveLength(13);
        expect(params[4]).toHaveLength(14);
        return result([
          row({
            id: "configuration-id",
            version: "1",
            client_secret_envelope: JSON.parse(String(params[2])),
            bot_scopes: params[3],
            user_scopes: params[4],
            socket_mode_enabled: params[5],
            socket_api_app_id: params[6],
            socket_app_token_envelope: JSON.parse(String(params[7]))
          })
        ]);
      }
      if (sql.includes("insert into prism_activity_audit")) {
        expect(serialized).not.toMatch(/client-id|chat:write|client-secret/i);
        return result([auditRow(params)]);
      }
      throw new Error(`unexpected-sql:${sql.slice(0, 80)}`);
    });
    const database = transactionDatabase(tx);
    const store = createPostgresSlackAppConfigurationStore(database, cipher, {
      randomId: () => "configuration-id"
    });

    const created = await store.createPendingConfiguration({
      setupSessionId: "setup-session",
      expectedPendingVersionId: null,
      clientId: "client-id",
      clientSecret: secret,
      socketModeEnabled: true,
      socketApiAppId: "A1234567890",
      socketAppToken: appToken,
      createdVia: "bootstrap",
      createdByPrismUserId: null,
      now: new Date("2026-08-23T00:00:00.000Z"),
      audit: { endpoint: "/v1/prism/setup/slack-configuration", requestId: "request-id" }
    });

    expect(created).toMatchObject({
      id: "configuration-id",
      status: "pending",
      secretConfigured: true,
      socketModeEnabled: true,
      socketApiAppId: "A1234567890",
      socketAppTokenConfigured: true,
      botScopes: expect.arrayContaining(["channels:read", "chat:write", "users:read"]),
      userScopes: expect.arrayContaining(["channels:read", "chat:write", "search:read"])
    });
    expect(JSON.stringify(created)).not.toContain(secret);
    expect(queries.some(({ sql }) => sql.includes("insert into prism_activity_audit"))).toBe(true);
    const envelope = JSON.parse(String(queries.find(({ sql }) => sql.includes("insert into prism_slack_app_configuration_versions"))!.params[2]));
    await expect(cipher.decrypt(envelope, slackAppConfigurationSecretAad("configuration-id"))).resolves.toBe(secret);
    await expect(cipher.decrypt(envelope, slackAppConfigurationSecretAad("another-id"))).rejects.toThrow(
      "credential-decryption-failed"
    );
    const socketEnvelope = JSON.parse(String(queries.find(({ sql }) => sql.includes("insert into prism_slack_app_configuration_versions"))!.params[7]));
    await expect(cipher.decrypt(socketEnvelope, slackSocketAppTokenAad("configuration-id"))).resolves.toBe(appToken);
  });

  it("requires the optimistic pending version and never overwrites a competing edit", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from prism_setup_sessions")) return result([{ id: "setup-session" }]);
      if (sql.includes("from prism_slack_app_configuration_versions")) {
        return result([{ id: "newer-pending" }]);
      }
      throw new Error("query-after-conflict");
    });
    const database = transactionDatabase(fakeDatabase(query));
    const store = createPostgresSlackAppConfigurationStore(
      database,
      createLocalAesGcmCredentialCipher({ key: testKey, keyId: "test-key" })
    );

    await expect(
      store.createPendingConfiguration({
        setupSessionId: "setup-session",
        expectedPendingVersionId: "older-pending",
        clientId: "client-id",
        clientSecret: "secret-canary",
        userScopes: ["chat:write"],
        createdVia: "bootstrap",
        createdByPrismUserId: null,
        audit: { endpoint: "/setup", requestId: "request-id" }
      })
    ).rejects.toMatchObject({ code: "pending-conflict" });
  });

  it("resolves only active or setup-authorized pending versions", async () => {
    const envelope = await createLocalAesGcmCredentialCipher({ key: testKey, keyId: "test-key" }).encrypt(
      "secret",
      slackAppConfigurationSecretAad("configuration-id")
    );
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("v.status = 'active'")) return result([row({ client_secret_envelope: envelope })]);
      if (sql.includes("join prism_setup_sessions")) {
        expect(params?.slice(0, 2)).toEqual(["setup-session", new Date("2026-08-23T00:00:00.000Z")]);
        return result([row({ client_secret_envelope: envelope })]);
      }
      throw new Error(`unexpected-sql:${sql.slice(0, 80)}`);
    });
    const store = createPostgresSlackAppConfigurationStore(
      fakeDatabase(query),
      createLocalAesGcmCredentialCipher({ key: testKey, keyId: "test-key" })
    );

    await expect(store.getActiveConfiguration()).resolves.toMatchObject({ id: "configuration-id", status: "pending" });
    await expect(
      store.getPendingConfigurationForSetupSession({
        setupSessionId: "setup-session",
        now: new Date("2026-08-23T00:00:00.000Z")
      })
    ).resolves.toMatchObject({ id: "configuration-id" });
  });

  it("activates an exact pending version inside the caller transaction and audits it", async () => {
    const envelope = await createLocalAesGcmCredentialCipher({ key: testKey, keyId: "test-key" }).encrypt(
      "secret",
      slackAppConfigurationSecretAad("configuration-id")
    );
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("for update") && sql.includes("v.status = 'pending'")) {
        expect(params?.slice(0, 3)).toEqual([
          "configuration-id",
          "setup-session",
          new Date("2026-08-23T00:00:00.000Z")
        ]);
        return result([row({ client_secret_envelope: envelope })]);
      }
      if (sql.includes("set status = 'superseded'")) return result([]);
      if (sql.includes("set status = 'active'")) {
        return result([
          row({ status: "active", activated_at: new Date("2026-08-23T00:00:00.000Z"), client_secret_envelope: envelope })
        ]);
      }
      if (sql.includes("insert into prism_activity_audit")) return result([auditRow(params ?? [])]);
      throw new Error(`unexpected-sql:${sql.slice(0, 80)}`);
    });
    const database = fakeDatabase(query);
    database.transaction = vi.fn(async () => {
      throw new Error("activation-must-use-caller-transaction");
    });
    const store = createPostgresSlackAppConfigurationStore(
      database,
      createLocalAesGcmCredentialCipher({ key: testKey, keyId: "test-key" })
    );

    await expect(
      store.activatePendingConfigurationInTransaction({
        versionId: "configuration-id",
        setupSessionId: "setup-session",
        activatedByPrismUserId: "prism-user",
        now: new Date("2026-08-23T00:00:00.000Z"),
        audit: { endpoint: "/v1/slack/oauth/callback", requestId: "request-id" }
      })
    ).resolves.toMatchObject({ id: "configuration-id", status: "active", secretConfigured: true });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when an exact pending activation binding is unavailable", async () => {
    const store = createPostgresSlackAppConfigurationStore(
      fakeDatabase(async () => result([])),
      createLocalAesGcmCredentialCipher({ key: testKey, keyId: "test-key" })
    );
    await expect(
      store.activatePendingConfigurationInTransaction({
        versionId: "missing",
        setupSessionId: "setup-session",
        activatedByPrismUserId: "prism-user",
        audit: { endpoint: "/callback", requestId: "request-id" }
      })
    ).rejects.toBeInstanceOf(SlackAppConfigurationStoreError);
  });
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "configuration-id",
    version: "1",
    status: "pending",
    client_id: "client-id",
    client_secret_envelope: {
      algorithm: "local-aes-256-gcm-v1",
      keyId: "test-key",
      iv: "aXY=",
      tag: "dGFn",
      ciphertext: "Y2lwaGVydGV4dA=="
    },
    bot_scopes: [],
    user_scopes: ["chat:write"],
    socket_mode_enabled: false,
    socket_api_app_id: null,
    socket_app_token_envelope: null,
    created_via: "bootstrap",
    created_by_prism_user_id: null,
    setup_session_id: "setup-session",
    created_at: new Date("2026-08-23T00:00:00.000Z"),
    activated_at: null,
    superseded_at: null,
    ...overrides
  };
}

function auditRow(params: unknown[]) {
  return {
    id: params[0],
    prism_user_id: params[1],
    slack_connection_id: params[2],
    token_profile_id: params[3],
    token_profile_name: params[4],
    slack_user_id: params[5],
    slack_team_id: params[6],
    slack_enterprise_id: params[7],
    activity_type: params[8],
    endpoint: params[9],
    slack_method: params[10],
    action_category: params[11],
    surface: params[12],
    object_type: params[13],
    object_id: params[14],
    execution_mode: params[15],
    status: params[16],
    error_class: params[17],
    http_status: params[18],
    request_id: params[19],
    upstream_called: params[20],
    occurred_at: params[21],
    retention_expires_at: params[22]
  };
}

function result<Row>(rows: Row[]): QueryResult<Row & Record<string, unknown>> {
  return { rows: rows as Array<Row & Record<string, unknown>>, rowCount: rows.length };
}

function fakeDatabase(query: unknown): Database {
  return {
    query: query as Database["query"],
    async transaction(callback) {
      return callback(this);
    }
  };
}

function transactionDatabase(tx: Database): Database {
  return {
    query: async () => {
      throw new Error("query-outside-transaction");
    },
    async transaction(callback) {
      return callback(tx);
    }
  };
}
