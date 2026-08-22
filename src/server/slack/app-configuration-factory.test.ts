import { describe, expect, it, vi } from "vitest";

import { createLocalAesGcmCredentialCipher } from "../credentials/encryption";
import { ALL_PRISM_SUPPORTED_SLACK_SCOPES } from "./app-configuration";
import type { SlackAppConfigurationStore } from "./app-configuration-postgres-store";
import { slackAppConfigurationSecretAad } from "./app-configuration-postgres-store";
import {
  SlackAppConfigurationResolutionError,
  createConfiguredSlackOAuthClient,
  createOptionalConfiguredSlackOAuthClient,
  createSlackAppConfigurationResolver,
  deriveSlackAppConfigurationFingerprintKey,
  type SlackAppConfigurationResolver
} from "./app-configuration-factory";
import type { SlackOAuthClient } from "./oauth-client";

const rootKey = Buffer.alloc(32, 4);
const cipher = createLocalAesGcmCredentialCipher({ key: rootKey.toString("base64"), keyId: "test-key" });

describe("effective Slack app configuration resolver", () => {
  it("derives a deterministic fingerprint subkey distinct from the AES root", () => {
    const derived = deriveSlackAppConfigurationFingerprintKey(rootKey);
    expect(derived).toHaveLength(32);
    expect(derived.equals(rootKey)).toBe(false);
    expect(deriveSlackAppConfigurationFingerprintKey(rootKey).equals(derived)).toBe(true);
    expect(
      deriveSlackAppConfigurationFingerprintKey(Buffer.alloc(32, 5)).equals(derived)
    ).toBe(false);
  });

  it("locks to a complete real environment bundle without reading Postgres", async () => {
    const store = fakeStore();
    const resolver = createSlackAppConfigurationResolver({
      env: realEnvironment(),
      store,
      cipher,
      fingerprintKey: rootKey
    });

    await expect(resolver.resolveOrdinary()).resolves.toMatchObject({
      source: "environment",
      environmentLocked: true,
      setupRequired: false,
      binding: { kind: "environment", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
      oauthConfig: { clientId: "real-client", userScopes: expect.arrayContaining(["chat:write"]) }
    });
    await expect(resolver.getStatus()).resolves.toMatchObject({ kind: "environment_locked" });
    expect(store.getActiveConfiguration).not.toHaveBeenCalled();
  });

  it("fails a partial environment credential pair before consulting Postgres", async () => {
    const store = fakeStore();
    expect(() =>
      createSlackAppConfigurationResolver({
        env: { ...deploymentEnvironment(), SLACK_CLIENT_ID: "partial-client" },
        store,
        cipher,
        fingerprintKey: rootKey
      })
    ).toThrow("setup-required:SLACK_OAUTH_CREDENTIAL_PAIR");
    expect(store.getActiveConfiguration).not.toHaveBeenCalled();
  });

  it("uses the active DB version when no real environment bundle exists", async () => {
    const active = await storedConfiguration({ status: "active" });
    const store = fakeStore({ active });
    const resolver = createSlackAppConfigurationResolver({
      env: deploymentEnvironment(),
      store,
      cipher,
      fingerprintKey: rootKey
    });

    const result = await resolver.resolveOrdinary();
    expect(result).toMatchObject({
      source: "database",
      environmentLocked: false,
      setupRequired: false,
      binding: { kind: "database", versionId: "configuration-id", setupSessionId: null },
      revision: { kind: "database", versionId: "configuration-id", version: "3" },
      oauthConfig: { clientId: "database-client", clientSecret: "database-secret" }
    });
    expect(JSON.stringify(result.summary)).not.toContain("database-secret");
  });

  it("creates refresh clients from the effective active DB configuration", async () => {
    const active = await storedConfiguration({ status: "active" });
    const resolver = createSlackAppConfigurationResolver({
      env: deploymentEnvironment(),
      store: fakeStore({ active }),
      cipher,
      fingerprintKey: rootKey
    });
    const client: SlackOAuthClient = {
      exchangeCode: vi.fn(),
      refreshToken: vi.fn()
    };
    const oauthClientFactory = vi.fn(() => client);
    const mockOAuthClientFactory = vi.fn(() => client);

    await expect(
      createConfiguredSlackOAuthClient({
        resolver,
        oauthClientFactory,
        mockOAuthClientFactory
      })
    ).resolves.toBe(client);
    expect(oauthClientFactory).toHaveBeenCalledWith({
      clientId: "database-client",
      clientSecret: "database-secret"
    });
    expect(mockOAuthClientFactory).not.toHaveBeenCalled();
  });

  it("creates real-environment refresh clients through the fetch adapter", async () => {
    const resolver = createSlackAppConfigurationResolver({
      env: realEnvironment(),
      store: fakeStore(),
      cipher,
      fingerprintKey: rootKey
    });
    const fetchClient: SlackOAuthClient = {
      exchangeCode: vi.fn(),
      refreshToken: vi.fn()
    };
    const mockClient: SlackOAuthClient = {
      exchangeCode: vi.fn(),
      refreshToken: vi.fn()
    };
    const oauthClientFactory = vi.fn(() => fetchClient);
    const mockOAuthClientFactory = vi.fn(() => mockClient);

    await expect(
      createConfiguredSlackOAuthClient({
        resolver,
        oauthClientFactory,
        mockOAuthClientFactory
      })
    ).resolves.toBe(fetchClient);
    expect(oauthClientFactory).toHaveBeenCalledWith({
      clientId: "real-client",
      clientSecret: "real-secret"
    });
    expect(mockOAuthClientFactory).not.toHaveBeenCalled();
  });

  it("keeps development mock refresh fully synthetic with its resolved scopes", async () => {
    const resolver = createSlackAppConfigurationResolver({
      env: mockEnvironment(),
      store: fakeStore(),
      cipher,
      fingerprintKey: rootKey
    });
    const fetchClient: SlackOAuthClient = {
      exchangeCode: vi.fn(),
      refreshToken: vi.fn()
    };
    const mockClient: SlackOAuthClient = {
      exchangeCode: vi.fn(),
      refreshToken: vi.fn()
    };
    const oauthClientFactory = vi.fn(() => fetchClient);
    const mockOAuthClientFactory = vi.fn(() => mockClient);

    await expect(
      createConfiguredSlackOAuthClient({
        resolver,
        oauthClientFactory,
        mockOAuthClientFactory
      })
    ).resolves.toBe(mockClient);
    expect(oauthClientFactory).not.toHaveBeenCalled();
    expect(mockOAuthClientFactory).toHaveBeenCalledWith({
      botScopes: ALL_PRISM_SUPPORTED_SLACK_SCOPES.botScopes,
      userScopes: ALL_PRISM_SUPPORTED_SLACK_SCOPES.userScopes
    });
  });

  it("keeps refresh optional only while Slack application setup is required", async () => {
    const setupRequiredResolver: Pick<SlackAppConfigurationResolver, "resolveOrdinary"> = {
      resolveOrdinary: vi.fn(async () => {
        throw new SlackAppConfigurationResolutionError("setup-required");
      })
    };
    const invalidBindingResolver: Pick<SlackAppConfigurationResolver, "resolveOrdinary"> = {
      resolveOrdinary: vi.fn(async () => {
        throw new SlackAppConfigurationResolutionError("binding-invalid");
      })
    };
    const oauthClientFactory = vi.fn();

    await expect(
      createOptionalConfiguredSlackOAuthClient({
        resolver: setupRequiredResolver,
        oauthClientFactory
      })
    ).resolves.toBeUndefined();
    await expect(
      createOptionalConfiguredSlackOAuthClient({
        resolver: invalidBindingResolver,
        oauthClientFactory
      })
    ).rejects.toMatchObject({ code: "binding-invalid" });
    expect(oauthClientFactory).not.toHaveBeenCalled();
  });

  it("treats the dev mock as a non-locking fallback behind an active DB version", async () => {
    const active = await storedConfiguration({ status: "active" });
    const store = fakeStore({ active });
    const resolver = createSlackAppConfigurationResolver({
      env: mockEnvironment(),
      store,
      cipher,
      fingerprintKey: rootKey
    });

    await expect(resolver.resolveOrdinary()).resolves.toMatchObject({
      source: "database",
      oauthConfig: { clientId: "database-client", mockOAuth: false }
    });
    await expect(resolver.getStatus()).resolves.toMatchObject({ kind: "active" });
  });

  it("keeps the dev mock available while reporting first-run setup required", async () => {
    const store = fakeStore();
    const resolver = createSlackAppConfigurationResolver({
      env: mockEnvironment(),
      store,
      cipher,
      fingerprintKey: rootKey
    });

    await expect(resolver.resolveOrdinary()).resolves.toMatchObject({
      source: "development_mock",
      environmentLocked: false,
      setupRequired: true,
      oauthConfig: { clientId: "mock-playtest-client", mockOAuth: true }
    });
    await expect(resolver.getStatus()).resolves.toEqual({
      kind: "setup_required",
      developmentMockAvailable: true
    });
  });

  it("treats the reserved mock bundle as absent in production so DB or setup can win", async () => {
    const active = await storedConfiguration({ status: "active" });
    const databaseResolver = createSlackAppConfigurationResolver({
      env: productionMockEnvironment(),
      store: fakeStore({ active }),
      cipher,
      fingerprintKey: rootKey
    });
    const setupResolver = createSlackAppConfigurationResolver({
      env: productionMockEnvironment(),
      store: fakeStore(),
      cipher,
      fingerprintKey: rootKey
    });

    await expect(databaseResolver.resolveOrdinary()).resolves.toMatchObject({
      source: "database",
      oauthConfig: { clientId: "database-client", mockOAuth: false }
    });
    await expect(setupResolver.getStatus()).resolves.toEqual({
      kind: "setup_required",
      developmentMockAvailable: false
    });
    await expect(setupResolver.resolveOrdinary()).rejects.toMatchObject({
      code: "setup-required"
    });
  });

  it("uses an authorized pending DB version for setup verification even with dev mock env", async () => {
    const pending = await storedConfiguration({ status: "pending" });
    const store = fakeStore({ pending });
    const resolver = createSlackAppConfigurationResolver({
      env: mockEnvironment(),
      store,
      cipher,
      fingerprintKey: rootKey
    });

    await expect(
      resolver.resolvePendingForSetupSession({ setupSessionId: "setup-session" })
    ).resolves.toMatchObject({
      source: "database",
      binding: {
        kind: "database",
        versionId: "configuration-id",
        setupSessionId: "setup-session"
      },
      oauthConfig: { clientId: "database-client", mockOAuth: false }
    });
  });

  it("does not allow pending DB verification to shadow a real environment bundle", async () => {
    const pending = await storedConfiguration({ status: "pending" });
    const resolver = createSlackAppConfigurationResolver({
      env: realEnvironment(),
      store: fakeStore({ pending }),
      cipher,
      fingerprintKey: rootKey
    });
    await expect(
      resolver.resolvePendingForSetupSession({ setupSessionId: "setup-session" })
    ).rejects.toMatchObject({ code: "environment-locked" });
  });

  it("fails closed with no active, real environment, or dev mock source", async () => {
    const resolver = createSlackAppConfigurationResolver({
      env: deploymentEnvironment(),
      store: fakeStore(),
      cipher,
      fingerprintKey: rootKey
    });
    await expect(resolver.resolveOrdinary()).rejects.toBeInstanceOf(SlackAppConfigurationResolutionError);
    await expect(resolver.getStatus()).resolves.toEqual({
      kind: "setup_required",
      developmentMockAvailable: false
    });
  });

  it("resolves only the exact immutable binding and rejects environment drift", async () => {
    const store = fakeStore({ active: await storedConfiguration({ status: "active" }) });
    const resolver = createSlackAppConfigurationResolver({
      env: realEnvironment(),
      store,
      cipher,
      fingerprintKey: rootKey
    });
    const started = await resolver.resolveOrdinary();
    await expect(resolver.resolveBinding({ binding: started.binding })).resolves.toMatchObject({
      source: "environment"
    });

    const drifted = createSlackAppConfigurationResolver({
      env: { ...realEnvironment(), SLACK_CLIENT_SECRET: "changed-secret" },
      store,
      cipher,
      fingerprintKey: rootKey
    });
    await expect(drifted.resolveBinding({ binding: started.binding })).rejects.toMatchObject({
      code: "binding-invalid"
    });
  });
});

function deploymentEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
    PRISM_OIDC_ALLOW_INSECURE_HTTP: "1"
  };
}

function realEnvironment(): NodeJS.ProcessEnv {
  return {
    ...deploymentEnvironment(),
    SLACK_CLIENT_ID: "real-client",
    SLACK_CLIENT_SECRET: "real-secret"
  };
}

function mockEnvironment(): NodeJS.ProcessEnv {
  return {
    ...deploymentEnvironment(),
    SLACK_CLIENT_ID: "mock-playtest-client",
    SLACK_CLIENT_SECRET: "mock-secret",
    PRISM_SLACK_OAUTH_MOCK: "1"
  };
}

function productionMockEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PRISM_PUBLIC_BASE_URL: "https://prism.invalid",
    SLACK_OAUTH_REDIRECT_URI: "https://prism.invalid/v1/slack/oauth/callback",
    SLACK_CLIENT_ID: "mock-playtest-client",
    SLACK_CLIENT_SECRET: "mock-secret",
    PRISM_SLACK_OAUTH_MOCK: "1"
  };
}

async function storedConfiguration(overrides: { status: "active" | "pending" }) {
  const id = "configuration-id";
  return {
    id,
    version: "3",
    status: overrides.status,
    clientId: "database-client",
    clientSecretEnvelope: await cipher.encrypt("database-secret", slackAppConfigurationSecretAad(id)),
    botScopes: ["channels:read" as const],
    userScopes: ["chat:write" as const],
    createdVia: "bootstrap" as const,
    createdByPrismUserId: null,
    setupSessionId: "setup-session",
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    activatedAt: overrides.status === "active" ? new Date("2026-08-23T00:05:00.000Z") : null,
    supersededAt: null
  };
}

function fakeStore(input: {
  active?: Awaited<ReturnType<typeof storedConfiguration>>;
  pending?: Awaited<ReturnType<typeof storedConfiguration>>;
} = {}): SlackAppConfigurationStore {
  return {
    createPendingConfiguration: vi.fn(),
    getActiveConfiguration: vi.fn(async () => input.active ?? null),
    getPendingConfigurationForSetupSession: vi.fn(async () => input.pending ?? null),
    getBoundConfiguration: vi.fn(async ({ versionId, setupSessionId }) => {
      const candidate = setupSessionId ? input.pending : input.active;
      return candidate && candidate.id === versionId ? candidate : null;
    }),
    activatePendingConfigurationInTransaction: vi.fn()
  };
}
