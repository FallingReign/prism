import { describe, expect, it } from "vitest";

import { createLocalAesGcmCredentialCipher } from "../credentials/encryption";
import { createSlackForwardingCredentialProvider } from "./forwarding-credentials";
import type { RefreshStore } from "./refresh";

const key = Buffer.alloc(32, 7).toString("base64");
const now = new Date("2026-01-01T00:00:00.000Z");

describe("Slack forwarding credential provider", () => {
  it("decrypts only the selected execution identity credential", async () => {
    const cipher = createLocalAesGcmCredentialCipher({ key, keyId: "forwarding-test" });
    const rows = [
      {
        connectionId: "conn_1",
        kind: "user" as const,
        tokenType: "user",
        accessTokenEnvelope: await cipher.encrypt("xoxp-selected-user-token-canary", "slack-connection:conn_1:user:access"),
        refreshTokenEnvelope: null,
        expiresAt: new Date(now.getTime() + 120_000),
        scopes: "search:read"
      },
      {
        connectionId: "conn_1",
        kind: "bot" as const,
        tokenType: "bot",
        accessTokenEnvelope: await cipher.encrypt("xoxb-unselected-bot-token-canary", "slack-connection:conn_1:bot:access"),
        refreshTokenEnvelope: null,
        expiresAt: new Date(now.getTime() + 120_000),
        scopes: "channels:read"
      }
    ];
    const store: RefreshStore = {
      async getCredentialForRefresh({ connectionId, kind }) {
        return rows.find((row) => row.connectionId === connectionId && row.kind === kind) ?? null;
      },
      async saveRefreshedCredential() {
        throw new Error("not used");
      },
      async markConnectionHealthy() {
        throw new Error("not used");
      },
      async markConnectionReauthRequired() {
        throw new Error("not used");
      }
    };
    const provider = createSlackForwardingCredentialProvider({ store, cipher, now: () => now });

    await expect(provider.getAccessToken({ connectionId: "conn_1", kind: "user" })).resolves.toEqual({
      kind: "available",
      accessToken: "xoxp-selected-user-token-canary"
    });
  });

  it("refreshes expired credentials before returning the Slack access token", async () => {
    const cipher = createLocalAesGcmCredentialCipher({ key, keyId: "forwarding-test" });
    const rows = [
      {
        connectionId: "conn_1",
        kind: "bot" as const,
        tokenType: "bot",
        accessTokenEnvelope: await cipher.encrypt("xoxb-expired-access-token-canary", "slack-connection:conn_1:bot:access"),
        refreshTokenEnvelope: await cipher.encrypt("bot-refresh-secret-canary", "slack-connection:conn_1:bot:refresh"),
        expiresAt: now,
        scopes: "channels:read"
      }
    ];
    const store: RefreshStore = {
      async getCredentialForRefresh({ connectionId, kind }) {
        return rows.find((row) => row.connectionId === connectionId && row.kind === kind) ?? null;
      },
      async saveRefreshedCredential(input) {
        Object.assign(rows[0]!, input);
      },
      async markConnectionHealthy() {
        return undefined;
      },
      async markConnectionReauthRequired() {
        throw new Error("not used");
      }
    };
    const provider = createSlackForwardingCredentialProvider({
      store,
      cipher,
      now: () => now,
      slackOAuthClient: {
        async exchangeCode() {
          throw new Error("not used");
        },
        async refreshToken({ refreshToken, kind }) {
          expect(refreshToken).toBe("bot-refresh-secret-canary");
          expect(kind).toBe("bot");
          return {
            ok: true,
            appId: "A123",
            team: { id: "T123" },
            authedUser: { id: "U123" },
            bot: {
              accessToken: "xoxb-refreshed-access-token-canary",
              refreshToken: "bot-refreshed-refresh-secret-canary",
              tokenType: "bot",
              expiresIn: 3600,
              scope: "channels:read"
            }
          };
        }
      }
    });

    await expect(provider.getAccessToken({ connectionId: "conn_1", kind: "bot" })).resolves.toEqual({
      kind: "available",
      accessToken: "xoxb-refreshed-access-token-canary"
    });
    expect(JSON.stringify(rows)).not.toContain("xoxb-refreshed-access-token-canary");
    expect(JSON.stringify(rows)).not.toContain("bot-refreshed-refresh-secret-canary");
  });
});
