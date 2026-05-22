import { describe, expect, it } from "vitest";

import { createLocalAesGcmCredentialCipher } from "../credentials/encryption";
import { completeSlackOAuthCallback, createSlackOAuthStart, type OAuthFlowStore } from "./oauth-flow";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const now = new Date("2026-01-01T00:00:00.000Z");

function createMemoryStore(): OAuthFlowStore & { rows: Record<string, unknown[]> } {
  const rows = {
    states: [] as any[],
    users: [] as any[],
    connections: [] as any[],
    credentials: [] as any[],
    sessions: [] as any[],
    tokenProfiles: [] as any[]
  };

  return {
    rows,
    async saveOAuthState(state) {
      rows.states.push({ ...state });
    },
    async consumeOAuthState({ stateHash, now: consumedAt }) {
      const state = rows.states.find((row) => row.stateHash === stateHash);
      if (!state || state.usedAt || state.expiresAt <= consumedAt) return null;
      state.usedAt = consumedAt;
      return { redirectUri: state.redirectUri };
    },
    async upsertPrismUser(input) {
      const existing = rows.users.find((row) => row.slackTeamId === input.slackTeamId && row.slackUserId === input.slackUserId);
      if (existing) return existing;
      const user = { id: `user_${rows.users.length + 1}`, ...input };
      rows.users.push(user);
      return user;
    },
    async upsertSlackConnection(input) {
      const existing = rows.connections.find((row) => row.teamId === input.teamId && row.authedUserId === input.authedUserId);
      if (existing) {
        Object.assign(existing, input, { status: "healthy", lastErrorClass: null });
        return existing;
      }
      const connection = { id: `conn_${rows.connections.length + 1}`, ...input, status: "healthy", lastErrorClass: null };
      rows.connections.push(connection);
      return connection;
    },
    async saveSlackCredential(input) {
      rows.credentials = rows.credentials.filter((row) => !(row.connectionId === input.connectionId && row.kind === input.kind));
      rows.credentials.push({ ...input });
    },
    async createWebsiteSession(input) {
      rows.sessions.push({ ...input });
    },
    async ensureTokenProfile(input) {
      if (!rows.tokenProfiles.some((row) => row.prismUserId === input.prismUserId && row.slackConnectionId === input.slackConnectionId)) {
        rows.tokenProfiles.push({ id: `profile_${rows.tokenProfiles.length + 1}`, ...input });
      }
    }
  };
}

describe("Slack OAuth flow", () => {
  it("creates a one-time state and Slack authorize redirect without exposing client secret", async () => {
    const store = createMemoryStore();

    const start = await createSlackOAuthStart({
      store,
      config: {
        clientId: "client-id-123",
        clientSecret: "client-secret-must-not-appear",
        redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
        publicBaseUrl: "http://localhost:3732",
        botScopes: ["channels:read", "chat:write"],
        userScopes: ["search:read"]
      },
      now,
      randomBytes: () => Buffer.alloc(32, 3)
    });

    expect(start.redirectUrl).toContain("https://slack.com/oauth/v2/authorize");
    expect(start.redirectUrl).toContain("client_id=client-id-123");
    expect(start.redirectUrl).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A3732%2Fv1%2Fslack%2Foauth%2Fcallback");
    expect(start.cookie.name).toBe("prism_slack_oauth_state");
    expect(start.cookie.httpOnly).toBe(true);
    expect(start.cookie.sameSite).toBe("lax");
    expect(JSON.stringify(start)).not.toContain("client-secret-must-not-appear");
    expect(JSON.stringify(store.rows.states)).not.toContain(start.state);
  });

  it("links a Slack identity, stores encrypted credentials, and creates a website session", async () => {
    const store = createMemoryStore();
    const cipher = createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" });
    const start = await createSlackOAuthStart({
      store,
      config: {
        clientId: "client-id-123",
        clientSecret: "client-secret-must-not-appear",
        redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
        publicBaseUrl: "http://localhost:3732",
        botScopes: ["channels:read"],
        userScopes: ["search:read"]
      },
      now,
      randomBytes: () => Buffer.alloc(32, 4)
    });

    const result = await completeSlackOAuthCallback({
      store,
      cipher,
      config: {
        clientId: "client-id-123",
        clientSecret: "client-secret-must-not-appear",
        redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
        publicBaseUrl: "http://localhost:3732",
        botScopes: ["channels:read"],
        userScopes: ["search:read"]
      },
      code: "valid-code",
      state: start.state,
      cookieState: start.state,
      now,
      randomBytes: () => Buffer.alloc(32, 5),
      slackOAuthClient: {
        async exchangeCode() {
          return {
            ok: true,
            appId: "A123",
            team: { id: "T123", name: "Example" },
            authedUser: {
              id: "U123",
              accessToken: "xoxp-user-token-canary",
              refreshToken: "user-refresh-secret-canary",
              tokenType: "user",
              expiresIn: 3600,
              scope: "search:read"
            },
            bot: {
              accessToken: "xoxb-bot-token-canary",
              refreshToken: "bot-refresh-secret-canary",
              tokenType: "bot",
              expiresIn: 3600,
              scope: "channels:read"
            }
          };
        },
        async refreshToken() {
          throw new Error("not used");
        }
      }
    });

    expect(result.kind).toBe("linked");
    expect(result.sessionCookie?.httpOnly).toBe(true);
    expect(result.redirectUrl).toBe("http://localhost:3732/?slack=linked");
    expect(store.rows.users).toHaveLength(1);
    expect(store.rows.connections).toMatchObject([{ prismUserId: "user_1", teamId: "T123", authedUserId: "U123", status: "healthy" }]);
    expect(store.rows.tokenProfiles).toHaveLength(0);

    const persisted = JSON.stringify(store.rows);
    expect(persisted).not.toContain("xoxb-bot-token-canary");
    expect(persisted).not.toContain("xoxp-user-token-canary");
    expect(persisted).not.toContain("refresh-secret-canary");
    expect(JSON.stringify(result)).not.toMatch(/xox[bp]-|refresh-secret|client-secret/i);
  });

  it("rejects replayed state before exchanging a Slack code", async () => {
    const store = createMemoryStore();
    const cipher = createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" });
    const start = await createSlackOAuthStart({
      store,
      config: {
        clientId: "client-id-123",
        clientSecret: "client-secret-must-not-appear",
        redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
        publicBaseUrl: "http://localhost:3732",
        botScopes: [],
        userScopes: []
      },
      now,
      randomBytes: () => Buffer.alloc(32, 6)
    });
    await store.consumeOAuthState({ stateHash: start.stateHash, now });
    let exchanged = false;

    const result = await completeSlackOAuthCallback({
      store,
      cipher,
      config: {
        clientId: "client-id-123",
        clientSecret: "client-secret-must-not-appear",
        redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
        publicBaseUrl: "http://localhost:3732",
        botScopes: [],
        userScopes: []
      },
      code: "valid-code",
      state: start.state,
      cookieState: start.state,
      now,
      randomBytes: () => Buffer.alloc(32, 7),
      slackOAuthClient: {
        async exchangeCode() {
          exchanged = true;
          throw new Error("must not exchange");
        },
        async refreshToken() {
          throw new Error("not used");
        }
      }
    });

    expect(result.kind).toBe("invalid_state");
    expect(exchanged).toBe(false);
    expect(result.redirectUrl).toBe("http://localhost:3732/?slack=error");
  });
});
