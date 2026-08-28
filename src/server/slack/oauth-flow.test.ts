import { describe, expect, it, vi } from "vitest";

import { createLocalAesGcmCredentialCipher } from "../credentials/encryption";
import { completeSlackOAuthCallback, createSlackOAuthStart, type OAuthFlowStore } from "./oauth-flow";
import type { SlackOAuthClient } from "./oauth-client";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const now = new Date("2026-01-01T00:00:00.000Z");
const environmentBinding = { kind: "environment", fingerprint: "a".repeat(64) } as const;

function createTestSlackOAuthStart(
  input: Omit<Parameters<typeof createSlackOAuthStart>[0], "configurationBinding">
) {
  return createSlackOAuthStart({ ...input, configurationBinding: environmentBinding });
}

function completeTestSlackOAuthCallback(
  input: Omit<
    Parameters<typeof completeSlackOAuthCallback>[0],
    "deployment" | "resolveRuntime" | "requestId"
  > & {
    config: Parameters<typeof createSlackOAuthStart>[0]["config"];
    slackOAuthClient: SlackOAuthClient;
  }
) {
  const { config, slackOAuthClient, ...rest } = input;
  return completeSlackOAuthCallback({
    ...rest,
    deployment: config,
    requestId: "oauth-flow-test-request",
    async resolveRuntime(binding) {
      expect(binding).toEqual(environmentBinding);
      return { config, slackOAuthClient };
    }
  });
}

function createMemoryStore(): OAuthFlowStore & { rows: Record<string, unknown[]> } {
  const rows = {
    states: [] as any[],
    users: [] as any[],
    connections: [] as any[],
    workspaceGrants: [] as any[],
    credentials: [] as any[],
    sessions: [] as any[],
    tokenProfiles: [] as any[],
    transactions: [] as any[]
  };

  const store: OAuthFlowStore & { rows: Record<string, unknown[]> } = {
    rows,
    async transaction(callback) {
      rows.transactions.push({ started: true });
      return callback(store);
    },
    async saveOAuthState(state) {
      rows.states.push({ ...state });
    },
    async consumeOAuthState({ stateHash, now: consumedAt }) {
      const state = rows.states.find((row) => row.stateHash === stateHash);
      if (!state || state.usedAt || state.expiresAt <= consumedAt) return null;
      state.usedAt = consumedAt;
      return {
        redirectUri: state.redirectUri,
        configurationBinding: state.configurationBinding,
        oidcAuthorizationRequestId: state.oidcAuthorizationRequestId ?? null,
        delegatedDeliveryRequestId: state.delegatedDeliveryRequestId ?? null
      };
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
    async upsertWorkspaceGrant(input) {
      const existing = rows.workspaceGrants.find((row) => row.connectionId === input.connectionId && row.teamId === input.teamId);
      if (existing) Object.assign(existing, input, { status: "active" });
      else rows.workspaceGrants.push({ ...input, status: "active" });
    },
    async replaceOrganizationGrants(input) {
      rows.workspaceGrants = rows.workspaceGrants.filter((row) => row.connectionId !== input.connectionId);
      rows.workspaceGrants.push(...input.teams.map((team) => ({ ...team, connectionId: input.connectionId, status: "active", verifiedAt: input.verifiedAt })));
    },
    async saveSlackCredential(input) {
      rows.credentials = rows.credentials.filter((row) => !(row.connectionId === input.connectionId && row.kind === input.kind));
      rows.credentials.push({ ...input });
    },
    async createWebsiteSession(input) {
      rows.sessions.push({ ...input });
    },
    async finalizeSetupConfiguration(input) {
      rows.transactions.push({ setupFinalized: true, ...input });
    }
  };

  return store;
}

describe("Slack OAuth flow", () => {
  it("creates a one-time state and Slack authorize redirect without exposing client secret", async () => {
    const store = createMemoryStore();

    const start = await createTestSlackOAuthStart({
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
    const start = await createTestSlackOAuthStart({
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

    const result = await completeTestSlackOAuthCallback({
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
            installationScope: "workspace",
            isEnterpriseInstall: false,
            team: { id: "T123", name: "Example" },
            enterprise: { id: "E123", name: "Example Enterprise" },
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
    expect(store.rows.connections).toMatchObject([
      {
        prismUserId: "user_1",
        teamId: "T123",
        teamName: "Example",
        enterpriseId: "E123",
        enterpriseName: "Example Enterprise",
        authedUserId: "U123",
        status: "healthy"
      }
    ]);
    expect(store.rows.tokenProfiles).toHaveLength(0);
    expect(store.rows.transactions).toHaveLength(1);
    expect(store.rows.sessions).toMatchObject([
      { prismUserId: "user_1", connectionId: "conn_1" }
    ]);

    const persisted = JSON.stringify(store.rows);
    expect(persisted).not.toContain("xoxb-bot-token-canary");
    expect(persisted).not.toContain("xoxp-user-token-canary");
    expect(persisted).not.toContain("refresh-secret-canary");
    expect(JSON.stringify(result)).not.toMatch(/xox[bp]-|refresh-secret|client-secret/i);
  });

  it("discovers and persists all organization workspace grants before completing the bound session", async () => {
    const store = createMemoryStore();
    const cipher = createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" });
    const config = {
      clientId: "client-id-123", clientSecret: "client-secret-must-not-appear",
      redirectUri: "http://localhost:3732/v1/slack/oauth/callback", publicBaseUrl: "http://localhost:3732",
      botScopes: ["channels:read"], userScopes: ["search:read"]
    };
    const start = await createTestSlackOAuthStart({ store, config, now, randomBytes: () => Buffer.alloc(32, 21) });
    const discoverOrganizationWorkspaces = vi.fn(async () => ({
      kind: "ok" as const,
      teams: [{ teamId: "T111", teamName: "2136a Dev" }, { teamId: "T222", teamName: "2136b Dev" }]
    }));

    const result = await completeTestSlackOAuthCallback({
      store, cipher, config, code: "valid-code", state: start.state, cookieState: start.state, now,
      randomBytes: () => Buffer.alloc(32, 22), discoverOrganizationWorkspaces,
      slackOAuthClient: {
        async exchangeCode() {
          return {
            ok: true, appId: "A123", installationScope: "organization", isEnterpriseInstall: true,
            team: null, enterprise: { id: "E123", name: "2136a" },
            authedUser: { id: "U123", accessToken: "xoxp-org-user-canary", tokenType: "user", scope: "search:read" },
            bot: { accessToken: "xoxb-org-bot-canary", tokenType: "bot", scope: "channels:read" }
          };
        },
        async refreshToken() { throw new Error("not used"); }
      }
    });

    expect(result).toMatchObject({
      kind: "linked", installationScope: "organization", organizationGrantSync: "complete", organizationGrantCount: 2
    });
    expect(result.redirectUrl).toBe("http://localhost:3732/?slack=linked&installation=organization&grants=2");
    expect(discoverOrganizationWorkspaces).toHaveBeenCalledWith("xoxp-org-user-canary");
    expect(store.rows.connections).toMatchObject([{ id: "conn_1", installationScope: "organization", teamId: null, enterpriseId: "E123" }]);
    expect(store.rows.workspaceGrants).toMatchObject([
      { connectionId: "conn_1", teamId: "T111", teamName: "2136a Dev", status: "active" },
      { connectionId: "conn_1", teamId: "T222", teamName: "2136b Dev", status: "active" }
    ]);
    expect(store.rows.sessions).toMatchObject([{ prismUserId: "user_1", connectionId: "conn_1" }]);
    expect(JSON.stringify(result)).not.toMatch(/xox[bp]-|client-secret/i);
  });

  it("keeps a valid organization connection when workspace discovery is unavailable", async () => {
    const store = createMemoryStore();
    const cipher = createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" });
    const config = {
      clientId: "client-id-123", clientSecret: "client-secret-must-not-appear",
      redirectUri: "http://localhost:3732/v1/slack/oauth/callback", publicBaseUrl: "http://localhost:3732",
      botScopes: [], userScopes: ["search:read"]
    };
    const start = await createTestSlackOAuthStart({ store, config, now, randomBytes: () => Buffer.alloc(32, 23) });

    const result = await completeTestSlackOAuthCallback({
      store, cipher, config, code: "valid-code", state: start.state, cookieState: start.state, now,
      randomBytes: () => Buffer.alloc(32, 24),
      discoverOrganizationWorkspaces: async () => ({ kind: "provider_error", error: "ratelimited" }),
      slackOAuthClient: {
        async exchangeCode() {
          return {
            ok: true, appId: "A123", installationScope: "organization", isEnterpriseInstall: true,
            team: null, enterprise: { id: "E123", name: "2136a" },
            authedUser: { id: "U123", accessToken: "xoxp-org-user-canary", tokenType: "user", scope: "search:read" }
          };
        },
        async refreshToken() { throw new Error("not used"); }
      }
    });

    expect(result).toMatchObject({ kind: "linked", installationScope: "organization", organizationGrantSync: "unavailable", organizationGrantCount: 0 });
    expect(result.redirectUrl).toBe("http://localhost:3732/?slack=linked&installation=organization&grant_sync=unavailable");
    expect(store.rows.connections).toHaveLength(1);
    expect(store.rows.sessions).toHaveLength(1);
    expect(store.rows.workspaceGrants).toHaveLength(0);
  });

  it("binds an OIDC authorization request to Slack state and returns it only after a successful callback", async () => {
    const store = createMemoryStore();
    const cipher = createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" });
    const start = await createTestSlackOAuthStart({
      store,
      config: {
        clientId: "client-id-123",
        clientSecret: "client-secret-must-not-appear",
        redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
        publicBaseUrl: "http://localhost:3732",
        botScopes: [],
        userScopes: []
      },
      oidcAuthorizationRequestId: "oidc_request_123",
      now,
      randomBytes: () => Buffer.alloc(32, 8)
    });

    expect(store.rows.states).toMatchObject([
      { oidcAuthorizationRequestId: "oidc_request_123" }
    ]);

    const result = await completeTestSlackOAuthCallback({
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
      randomBytes: () => Buffer.alloc(32, 9),
      slackOAuthClient: {
        async exchangeCode() {
          return {
            ok: true,
            appId: "A123",
            installationScope: "workspace",
            isEnterpriseInstall: false,
            team: { id: "T123" },
            enterprise: null,
            authedUser: { id: "U123" }
          };
        },
        async refreshToken() {
          throw new Error("not used");
        }
      }
    });

    expect(result).toMatchObject({
      kind: "linked",
      oidcAuthorizationRequestId: "oidc_request_123"
    });
  });

  it("preserves one typed delegated-delivery continuation and rejects mixed continuation types", async () => {
    const store = createMemoryStore();
    const config = {
      clientId: "client-id-123",
      clientSecret: "client-secret-must-not-appear",
      redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
      publicBaseUrl: "http://localhost:3732",
      botScopes: [],
      userScopes: ["chat:write"]
    };
    const delegatedDeliveryRequestId = "ddr_12345678-1234-4123-8123-123456789012";
    const start = await createTestSlackOAuthStart({
      store,
      config,
      delegatedDeliveryRequestId,
      now,
      randomBytes: () => Buffer.alloc(32, 12)
    });

    expect(store.rows.states).toMatchObject([{ delegatedDeliveryRequestId }]);
    await expect(createTestSlackOAuthStart({
      store,
      config,
      oidcAuthorizationRequestId: "r".repeat(43),
      delegatedDeliveryRequestId,
      now
    })).rejects.toThrow("slack-oauth-continuation-conflict");

    const result = await completeTestSlackOAuthCallback({
      store,
      cipher: createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" }),
      config,
      code: "valid-code",
      state: start.state,
      cookieState: start.state,
      now,
      randomBytes: () => Buffer.alloc(32, 13),
      slackOAuthClient: {
        async exchangeCode() {
          return {
            ok: true,
            appId: "A0123456789",
            installationScope: "workspace",
            isEnterpriseInstall: false,
            team: { id: "T0123456789" },
            enterprise: null,
            authedUser: {
              id: "U0123456789",
              scope: "chat:write",
              accessToken: "xoxp-delegated-user-token-canary",
              refreshToken: "delegated-user-refresh-canary",
              tokenType: "user",
              expiresIn: 3600
            }
          };
        },
        async refreshToken() { throw new Error("not used"); }
      }
    });

    expect(result).toMatchObject({ kind: "linked", delegatedDeliveryRequestId });
  });

  it("preserves the delegated continuation on Slack cancellation without linking", async () => {
    const store = createMemoryStore();
    const config = {
      clientId: "client-id-123",
      clientSecret: "client-secret-must-not-appear",
      redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
      publicBaseUrl: "http://localhost:3732",
      botScopes: [],
      userScopes: ["chat:write"]
    };
    const delegatedDeliveryRequestId = "ddr_12345678-1234-4123-8123-123456789012";
    const start = await createTestSlackOAuthStart({
      store, config, delegatedDeliveryRequestId, now,
      randomBytes: () => Buffer.alloc(32, 14)
    });

    const result = await completeTestSlackOAuthCallback({
      store,
      cipher: createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" }),
      config,
      code: null,
      state: start.state,
      cookieState: start.state,
      oauthError: "access_denied",
      now,
      slackOAuthClient: {
        async exchangeCode() { throw new Error("must not exchange"); },
        async refreshToken() { throw new Error("not used"); }
      }
    });

    expect(result).toEqual({
      kind: "slack_error",
      redirectUrl: "http://localhost:3732/?slack=error&reason=authorization_denied",
      failureReason: "authorization_denied",
      oidcAuthorizationRequestId: null,
      delegatedDeliveryRequestId
    });
    expect(store.rows.users).toHaveLength(0);
  });

  it("rejects malformed Slack success identity before creating a Prism user or session", async () => {
    const store = createMemoryStore();
    const cipher = createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" });
    const start = await createTestSlackOAuthStart({
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
      randomBytes: () => Buffer.alloc(32, 10)
    });

    const result = await completeTestSlackOAuthCallback({
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
      slackOAuthClient: {
        async exchangeCode() {
          return {
            ok: true,
            appId: "",
            installationScope: "workspace",
            isEnterpriseInstall: false,
            team: { id: "" },
            enterprise: null,
            authedUser: { id: "" }
          };
        },
        async refreshToken() {
          throw new Error("not used");
        }
      }
    });

    expect(result.kind).toBe("slack_error");
    expect(store.rows.users).toHaveLength(0);
    expect(store.rows.connections).toHaveLength(0);
    expect(store.rows.sessions).toHaveLength(0);
    expect(store.rows.transactions).toHaveLength(0);
  });

  it("rejects a reconnect that omits a configured user credential before marking the connection healthy", async () => {
    const store = createMemoryStore();
    const cipher = createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" });
    const config = {
      clientId: "client-id-123",
      clientSecret: "client-secret-must-not-appear",
      redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
      publicBaseUrl: "http://localhost:3732",
      botScopes: [],
      userScopes: ["chat:write"]
    };
    const start = await createTestSlackOAuthStart({
      store,
      config,
      now,
      randomBytes: () => Buffer.alloc(32, 18)
    });

    const result = await completeTestSlackOAuthCallback({
      store,
      cipher,
      config,
      code: "valid-code",
      state: start.state,
      cookieState: start.state,
      now,
      slackOAuthClient: {
        async exchangeCode() {
          return {
            ok: true,
            appId: "A123",
            installationScope: "workspace",
            isEnterpriseInstall: false,
            team: { id: "T123" },
            enterprise: null,
            authedUser: { id: "U123", scope: "chat:write" }
          };
        },
        async refreshToken() {
          throw new Error("not used");
        }
      }
    });

    expect(result.kind).toBe("slack_error");
    expect(store.rows.connections).toHaveLength(0);
    expect(store.rows.credentials).toHaveLength(0);
    expect(store.rows.sessions).toHaveLength(0);
    expect(store.rows.transactions).toHaveLength(0);
  });

  it("consumes a Slack cancellation and preserves only the bound OIDC request for a safe client error", async () => {
    const store = createMemoryStore();
    const cipher = createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" });
    const start = await createTestSlackOAuthStart({
      store,
      config: {
        clientId: "client-id-123",
        clientSecret: "client-secret-must-not-appear",
        redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
        publicBaseUrl: "http://localhost:3732",
        botScopes: [],
        userScopes: []
      },
      oidcAuthorizationRequestId: "oidc_request_cancelled",
      now,
      randomBytes: () => Buffer.alloc(32, 11)
    });
    let exchanged = false;

    const result = await completeTestSlackOAuthCallback({
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
      code: null,
      state: start.state,
      cookieState: start.state,
      oauthError: "access_denied",
      now,
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

    expect(result).toEqual({
      kind: "slack_error",
      redirectUrl: "http://localhost:3732/?slack=error&reason=authorization_denied",
      failureReason: "authorization_denied",
      oidcAuthorizationRequestId: "oidc_request_cancelled"
    });
    expect(exchanged).toBe(false);
    expect(store.rows.users).toHaveLength(0);
  });

  it("rejects replayed state before exchanging a Slack code", async () => {
    const store = createMemoryStore();
    const cipher = createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" });
    const start = await createTestSlackOAuthStart({
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

    const result = await completeTestSlackOAuthCallback({
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

  it("finalizes the exact setup configuration before creating the website session", async () => {
    const store = createMemoryStore();
    const cipher = createLocalAesGcmCredentialCipher({ key: encryptionKey, keyId: "local-test" });
    const config = {
      clientId: "client-id-123",
      clientSecret: "client-secret-must-not-appear",
      redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
      publicBaseUrl: "http://localhost:3732",
      botScopes: [],
      userScopes: ["chat:write"]
    };
    const configurationBinding = {
      kind: "database" as const,
      versionId: "configuration-version",
      setupSessionId: "setup-session"
    };
    const start = await createSlackOAuthStart({
      store,
      config,
      configurationBinding,
      now,
      randomBytes: () => Buffer.alloc(32, 15)
    });
    const slackOAuthClient: SlackOAuthClient = {
      async exchangeCode() {
        return {
          ok: true,
          appId: "A123",
          installationScope: "workspace",
          isEnterpriseInstall: false,
          team: { id: "T123" },
          enterprise: null,
          authedUser: {
            id: "U123",
            scope: "chat:write",
            accessToken: "xoxp-setup-user-token-canary",
            refreshToken: "setup-user-refresh-canary",
            tokenType: "user",
            expiresIn: 3600
          }
        };
      },
      async refreshToken() {
        throw new Error("not used");
      }
    };

    const result = await completeSlackOAuthCallback({
      store,
      cipher,
      deployment: config,
      async resolveRuntime(binding) {
        expect(binding).toEqual(configurationBinding);
        return { config, slackOAuthClient };
      },
      code: "valid-code",
      state: start.state,
      cookieState: start.state,
      requestId: "setup-callback-request",
      now,
      randomBytes: () => Buffer.alloc(32, 16)
    });

    expect(result).toMatchObject({
      kind: "linked",
      redirectUrl: "http://localhost:3732/setup?status=complete",
      setupConfigurationActivated: true
    });
    expect(store.rows.transactions).toContainEqual(expect.objectContaining({
      setupFinalized: true,
      configurationVersionId: "configuration-version",
      setupSessionId: "setup-session",
      prismUserId: "user_1",
      slackConnectionId: "conn_1"
    }));
    expect(store.rows.sessions).toHaveLength(1);
  });
});
