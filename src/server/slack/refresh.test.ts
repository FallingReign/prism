import { describe, expect, it } from "vitest";

import { createLocalAesGcmCredentialCipher } from "../credentials/encryption";
import { refreshSlackCredential, type RefreshStore } from "./refresh";

const key = Buffer.alloc(32, 8).toString("base64");
const now = new Date("2026-01-01T00:00:00.000Z");

function createStore() {
  const cipher = createLocalAesGcmCredentialCipher({ key, keyId: "refresh-test" });
  const rows = {
    connections: [{ id: "conn_1", status: "healthy", lastErrorClass: null as string | null }],
    tokenProfiles: [{ id: "profile_1", slackConnectionId: "conn_1" }],
    credentials: [] as any[]
  };
  const store: RefreshStore = {
    async getCredentialForRefresh({ connectionId, kind }) {
      return rows.credentials.find((row) => row.connectionId === connectionId && row.kind === kind) ?? null;
    },
    async saveRefreshedCredential(input) {
      const existing = rows.credentials.find((row) => row.connectionId === input.connectionId && row.kind === input.kind);
      Object.assign(existing, input);
    },
    async markConnectionHealthy(connectionId) {
      const row = rows.connections.find((connection) => connection.id === connectionId)!;
      row.status = "healthy";
      row.lastErrorClass = null;
    },
    async markConnectionReauthRequired(connectionId, errorClass) {
      const row = rows.connections.find((connection) => connection.id === connectionId)!;
      row.status = "reauth_required";
      row.lastErrorClass = errorClass;
    }
  };
  return { rows, store, cipher };
}

describe("Slack credential refresh", () => {
  it("rotates encrypted credential envelopes and leaves the Slack connection healthy", async () => {
    const { rows, store, cipher } = createStore();
    rows.credentials.push({
      connectionId: "conn_1",
      kind: "bot",
      tokenType: "bot",
      accessTokenEnvelope: await cipher.encrypt("xoxb-old-access-canary", "slack-connection:conn_1:bot:access"),
      refreshTokenEnvelope: await cipher.encrypt("old-refresh-secret-canary", "slack-connection:conn_1:bot:refresh"),
      expiresAt: now,
      scopes: "channels:read"
    });

    const result = await refreshSlackCredential({
      store,
      cipher,
      connectionId: "conn_1",
      kind: "bot",
      now,
      slackOAuthClient: {
        async exchangeCode() {
          throw new Error("not used");
        },
        async refreshToken({ refreshToken }) {
          expect(refreshToken).toBe("old-refresh-secret-canary");
          return {
            ok: true,
            credential: {
              accessToken: "xoxb-new-access-canary",
              refreshToken: "new-refresh-secret-canary",
              tokenType: "bot",
              expiresIn: 7200,
              scope: "channels:read"
            }
          };
        }
      }
    });

    expect(result).toEqual({ status: "refreshed" });
    expect(rows.connections[0]).toMatchObject({ status: "healthy", lastErrorClass: null });
    expect(rows.credentials[0].expiresAt).toEqual(new Date(now.getTime() + 7200 * 1000));
    const persisted = JSON.stringify(rows);
    expect(persisted).not.toContain("xoxb-new-access-canary");
    expect(persisted).not.toContain("new-refresh-secret-canary");
  });

  it("rotates encrypted user credential envelopes from user token refresh responses", async () => {
    const { rows, store, cipher } = createStore();
    rows.credentials.push({
      connectionId: "conn_1",
      kind: "user",
      tokenType: "user",
      accessTokenEnvelope: await cipher.encrypt("xoxp-old-access-canary", "slack-connection:conn_1:user:access"),
      refreshTokenEnvelope: await cipher.encrypt("old-user-refresh-secret-canary", "slack-connection:conn_1:user:refresh"),
      expiresAt: now,
      scopes: "search:read"
    });

    const result = await refreshSlackCredential({
      store,
      cipher,
      connectionId: "conn_1",
      kind: "user",
      now,
      slackOAuthClient: {
        async exchangeCode() {
          throw new Error("not used");
        },
        async refreshToken({ refreshToken, kind }) {
          expect(refreshToken).toBe("old-user-refresh-secret-canary");
          expect(kind).toBe("user");
          return {
            ok: true,
            credential: {
              accessToken: "xoxp-new-access-canary",
              refreshToken: "new-user-refresh-secret-canary",
              tokenType: "user",
              expiresIn: 3600,
              scope: "search:read"
            }
          };
        }
      }
    });

    expect(result).toEqual({ status: "refreshed" });
    expect(rows.connections[0]).toMatchObject({ status: "healthy", lastErrorClass: null });
    expect(rows.credentials[0].expiresAt).toEqual(new Date(now.getTime() + 3600 * 1000));
    const persisted = JSON.stringify(rows);
    expect(persisted).not.toContain("xoxp-new-access-canary");
    expect(persisted).not.toContain("new-user-refresh-secret-canary");
  });

  it("marks Reauth required on recoverable refresh failure without deleting token profiles", async () => {
    const { rows, store, cipher } = createStore();
    rows.credentials.push({
      connectionId: "conn_1",
      kind: "bot",
      tokenType: "bot",
      accessTokenEnvelope: await cipher.encrypt("xoxb-old-access-canary", "slack-connection:conn_1:bot:access"),
      refreshTokenEnvelope: await cipher.encrypt("old-refresh-secret-canary", "slack-connection:conn_1:bot:refresh"),
      expiresAt: now,
      scopes: "channels:read"
    });

    const result = await refreshSlackCredential({
      store,
      cipher,
      connectionId: "conn_1",
      kind: "bot",
      now,
      slackOAuthClient: {
        async exchangeCode() {
          throw new Error("not used");
        },
        async refreshToken() {
          return { ok: false, errorClass: "invalid_refresh_token" };
        }
      }
    });

    expect(result).toEqual({ status: "reauth_required", errorClass: "invalid_refresh_token" });
    expect(rows.connections[0]).toMatchObject({ status: "reauth_required", lastErrorClass: "invalid_refresh_token" });
    expect(rows.tokenProfiles).toEqual([{ id: "profile_1", slackConnectionId: "conn_1" }]);
    expect(rows.credentials).toHaveLength(1);
  });

  it("serializes a single-use refresh token and lets waiting callers reuse the rotated credential", async () => {
    const { rows, store, cipher } = createStore();
    rows.credentials.push({
      connectionId: "conn_1",
      kind: "user",
      tokenType: "user",
      accessTokenEnvelope: await cipher.encrypt("xoxp-old-access-canary", "slack-connection:conn_1:user:access"),
      refreshTokenEnvelope: await cipher.encrypt("old-user-refresh-secret-canary", "slack-connection:conn_1:user:refresh"),
      expiresAt: now,
      scopes: "chat:write"
    });
    let lockTail = Promise.resolve();
    const lockedStore: RefreshStore = {
      ...store,
      async withCredentialRefreshLock(_input, callback) {
        const previous = lockTail;
        let release!: () => void;
        lockTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await callback(store);
        } finally {
          release();
        }
      }
    };
    let refreshCalls = 0;
    const slackOAuthClient = {
      async exchangeCode() {
        throw new Error("not used");
      },
      async refreshToken() {
        refreshCalls += 1;
        return {
          ok: true as const,
          credential: {
            accessToken: "xoxp-new-access-canary",
            refreshToken: "new-user-refresh-secret-canary",
            tokenType: "user" as const,
            expiresIn: 3600,
            scope: "chat:write"
          }
        };
      }
    };

    await expect(Promise.all([
      refreshSlackCredential({ store: lockedStore, cipher, slackOAuthClient, connectionId: "conn_1", kind: "user", now }),
      refreshSlackCredential({ store: lockedStore, cipher, slackOAuthClient, connectionId: "conn_1", kind: "user", now })
    ])).resolves.toEqual([{ status: "refreshed" }, { status: "refreshed" }]);
    expect(refreshCalls).toBe(1);
  });
});
