import "server-only";

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import {
  getCredentialEncryptionConfig,
  getSlackOAuthDeploymentConfig,
  getSlackOAuthEnvironmentBundle,
  isSetupRequiredError,
  type SlackOAuthServerConfig
} from "../config";
import { createLocalAesGcmCredentialCipher, type CredentialCipher } from "../credentials/encryption";
import { database as configuredDatabase, type Database } from "../db";
import {
  redactSlackAppConfiguration,
  validateSlackAppConfigurationInput,
  type RedactedSlackAppConfiguration,
  type SlackAppConfigurationBinding,
  type SlackAppConfigurationRevision,
  type StoredSlackAppConfigurationVersion
} from "./app-configuration";
import {
  createPostgresSlackAppConfigurationStore,
  slackAppConfigurationSecretAad,
  type SlackAppConfigurationStore
} from "./app-configuration-postgres-store";
import { createMockSlackOAuthClient } from "./mock-oauth-client";
import { createFetchSlackOAuthClient, type SlackOAuthClient } from "./oauth-client";

export type EffectiveSlackAppConfigurationSource =
  | "environment"
  | "database"
  | "development_mock";

export type EffectiveSlackAppConfigurationSummary = {
  source: EffectiveSlackAppConfigurationSource;
  environmentLocked: boolean;
  setupRequired: boolean;
  id: string | null;
  version: string | null;
  status: "environment" | "development_mock" | "pending" | "active" | "superseded";
  clientId: string;
  secretConfigured: true;
  botScopes: string[];
  userScopes: string[];
  socketModeEnabled: boolean;
  socketApiAppId: string | null;
  socketAppTokenConfigured: boolean;
  callbackUri: string;
};

export type ResolvedSlackAppConfiguration = {
  source: EffectiveSlackAppConfigurationSource;
  environmentLocked: boolean;
  setupRequired: boolean;
  oauthConfig: SlackOAuthServerConfig;
  binding: SlackAppConfigurationBinding;
  revision: SlackAppConfigurationRevision;
  summary: EffectiveSlackAppConfigurationSummary;
};

export type SlackAppConfigurationStatus =
  | { kind: "environment_locked"; summary: EffectiveSlackAppConfigurationSummary }
  | { kind: "active"; summary: EffectiveSlackAppConfigurationSummary }
  | { kind: "setup_required"; developmentMockAvailable: boolean };

export type SlackAppConfigurationResolver = {
  resolveOrdinary(input?: { now?: Date }): Promise<ResolvedSlackAppConfiguration>;
  resolvePendingForSetupSession(input: {
    setupSessionId: string;
    now?: Date;
  }): Promise<ResolvedSlackAppConfiguration>;
  resolveBinding(input: {
    binding: SlackAppConfigurationBinding;
    now?: Date;
  }): Promise<ResolvedSlackAppConfiguration>;
  getStatus(input?: { now?: Date }): Promise<SlackAppConfigurationStatus>;
};

export class SlackAppConfigurationResolutionError extends Error {
  readonly code: "setup-required" | "environment-locked" | "binding-invalid";

  constructor(code: SlackAppConfigurationResolutionError["code"]) {
    super(
      code === "setup-required"
        ? "setup-required:SLACK_APP_CONFIGURATION"
        : `slack-app-configuration-resolution:${code}`
    );
    this.name = "SlackAppConfigurationResolutionError";
    this.code = code;
  }
}

export function createSlackAppConfigurationResolver({
  env,
  store,
  cipher,
  fingerprintKey
}: {
  env: NodeJS.ProcessEnv;
  store: SlackAppConfigurationStore;
  cipher: CredentialCipher;
  fingerprintKey: Buffer | string;
}): SlackAppConfigurationResolver {
  // Parsing occurs once so a partial environment pair fails before any DB
  // fallback. A dev mock is deliberately classified separately from a real,
  // authoritative secret-manager bundle.
  const environmentBundle = getSlackOAuthEnvironmentBundle(env);
  const deployment = getSlackOAuthDeploymentConfig(env);
  const realEnvironmentBundle = environmentBundle && !environmentBundle.mockOAuth ? environmentBundle : null;
  const developmentMockBundle = environmentBundle?.mockOAuth ? environmentBundle : null;

  return {
    async resolveOrdinary({ now = new Date() } = {}) {
      if (realEnvironmentBundle) {
        return resolveEnvironment(realEnvironmentBundle, "environment", false);
      }
      const active = await store.getActiveConfiguration();
      if (active) return resolveStored(active, null, now);
      if (developmentMockBundle) {
        return resolveEnvironment(developmentMockBundle, "development_mock", true);
      }
      throw new SlackAppConfigurationResolutionError("setup-required");
    },

    async resolvePendingForSetupSession({ setupSessionId, now = new Date() }) {
      if (realEnvironmentBundle) {
        throw new SlackAppConfigurationResolutionError("environment-locked");
      }
      const pending = await store.getPendingConfigurationForSetupSession({ setupSessionId, now });
      if (!pending) throw new SlackAppConfigurationResolutionError("binding-invalid");
      return resolveStored(pending, setupSessionId, now);
    },

    async resolveBinding({ binding, now = new Date() }) {
      if (binding.kind === "environment") {
        if (!environmentBundle) throw new SlackAppConfigurationResolutionError("binding-invalid");
        const expected = environmentFingerprint(environmentBundle, fingerprintKey);
        if (!equalFingerprint(binding.fingerprint, expected)) {
          throw new SlackAppConfigurationResolutionError("binding-invalid");
        }
        return resolveEnvironment(
          environmentBundle,
          environmentBundle.mockOAuth ? "development_mock" : "environment",
          environmentBundle.mockOAuth
        );
      }

      if (realEnvironmentBundle) {
        throw new SlackAppConfigurationResolutionError("binding-invalid");
      }
      const stored = await store.getBoundConfiguration({
        versionId: binding.versionId,
        setupSessionId: binding.setupSessionId,
        now
      });
      if (!stored) throw new SlackAppConfigurationResolutionError("binding-invalid");
      return resolveStored(stored, binding.setupSessionId, now);
    },

    async getStatus({ now = new Date() } = {}) {
      if (realEnvironmentBundle) {
        const resolved = resolveEnvironment(realEnvironmentBundle, "environment", false);
        return { kind: "environment_locked", summary: resolved.summary };
      }
      const active = await store.getActiveConfiguration();
      if (active) {
        const resolved = await resolveStored(active, null, now);
        return { kind: "active", summary: resolved.summary };
      }
      return {
        kind: "setup_required",
        developmentMockAvailable: Boolean(developmentMockBundle)
      };
    }
  };

  function resolveEnvironment(
    oauthConfig: SlackOAuthServerConfig,
    source: "environment" | "development_mock",
    setupRequired: boolean
  ): ResolvedSlackAppConfiguration {
    const fingerprint = environmentFingerprint(oauthConfig, fingerprintKey);
    const socketModeEnabled = source === "environment" && env.SLACK_SOCKET_MODE_ENABLED?.trim() === "1";
    const socketApiAppId = socketModeEnabled ? env.SLACK_API_APP_ID?.trim() ?? null : null;
    const socketAppTokenConfigured = socketModeEnabled && /^xapp-[A-Za-z0-9-]{16,}$/.test(env.SLACK_APP_TOKEN?.trim() ?? "");
    return {
      source,
      environmentLocked: source === "environment",
      setupRequired,
      oauthConfig: cloneOAuthConfig(oauthConfig),
      binding: { kind: "environment", fingerprint },
      revision: { kind: "environment", fingerprint },
      summary: {
        source,
        environmentLocked: source === "environment",
        setupRequired,
        id: null,
        version: null,
        status: source === "environment" ? "environment" : "development_mock",
        clientId: oauthConfig.clientId,
        secretConfigured: true,
        botScopes: [...oauthConfig.botScopes],
        userScopes: [...oauthConfig.userScopes],
        socketModeEnabled,
        socketApiAppId,
        socketAppTokenConfigured,
        callbackUri: oauthConfig.redirectUri
      }
    };
  }

  async function resolveStored(
    stored: StoredSlackAppConfigurationVersion,
    setupSessionId: string | null,
    _now: Date
  ): Promise<ResolvedSlackAppConfiguration> {
    try {
      const clientSecret = await cipher.decrypt(
        stored.clientSecretEnvelope,
        slackAppConfigurationSecretAad(stored.id)
      );
      const validated = validateSlackAppConfigurationInput(
        {
          clientId: stored.clientId,
          clientSecret,
          botScopes: stored.botScopes,
          userScopes: stored.userScopes
        },
        { production: env.NODE_ENV === "production" }
      );
      const oauthConfig: SlackOAuthServerConfig = {
        ...validated,
        ...deployment,
        mockOAuth: false
      };
      const redacted = redactSlackAppConfiguration(stored);
      return {
        source: "database",
        environmentLocked: false,
        setupRequired: false,
        oauthConfig,
        binding: { kind: "database", versionId: stored.id, setupSessionId },
        revision: { kind: "database", versionId: stored.id, version: stored.version },
        summary: databaseSummary(redacted, deployment.redirectUri)
      };
    } catch (error) {
      if (error instanceof SlackAppConfigurationResolutionError) throw error;
      throw new SlackAppConfigurationResolutionError("binding-invalid");
    }
  }
}

export function createConfiguredSlackAppConfigurationResolver({
  env = process.env,
  database = configuredDatabase
}: {
  env?: NodeJS.ProcessEnv;
  database?: Database;
} = {}): SlackAppConfigurationResolver {
  const encryption = getCredentialEncryptionConfig(env);
  const rawKey = Buffer.from(encryption.key, "base64");
  const cipher = createLocalAesGcmCredentialCipher({ key: encryption.key, keyId: encryption.keyId });
  const store = createPostgresSlackAppConfigurationStore(database, cipher, {
    production: env.NODE_ENV === "production"
  });
  return createSlackAppConfigurationResolver({
    env,
    store,
    cipher,
    fingerprintKey: deriveSlackAppConfigurationFingerprintKey(rawKey)
  });
}

type ConfiguredSlackOAuthClientOptions = {
  env?: NodeJS.ProcessEnv;
  database?: Database;
  resolver?: Pick<SlackAppConfigurationResolver, "resolveOrdinary">;
  oauthClientFactory?: typeof createFetchSlackOAuthClient;
  mockOAuthClientFactory?: typeof createMockSlackOAuthClient;
};

export async function createConfiguredSlackOAuthClient({
  env = process.env,
  database = configuredDatabase,
  resolver,
  oauthClientFactory = createFetchSlackOAuthClient,
  mockOAuthClientFactory = createMockSlackOAuthClient
}: ConfiguredSlackOAuthClientOptions = {}): Promise<SlackOAuthClient> {
  const effective = await (
    resolver ?? createConfiguredSlackAppConfigurationResolver({ env, database })
  ).resolveOrdinary();
  if (effective.oauthConfig.mockOAuth) {
    return mockOAuthClientFactory({
      botScopes: [...effective.oauthConfig.botScopes],
      userScopes: [...effective.oauthConfig.userScopes]
    });
  }
  return oauthClientFactory({
    clientId: effective.oauthConfig.clientId,
    clientSecret: effective.oauthConfig.clientSecret
  });
}

export async function createOptionalConfiguredSlackOAuthClient(
  options: ConfiguredSlackOAuthClientOptions = {}
): Promise<SlackOAuthClient | undefined> {
  try {
    return await createConfiguredSlackOAuthClient(options);
  } catch (error) {
    if (isSetupRequiredError(error)) return undefined;
    throw error;
  }
}

export function deriveSlackAppConfigurationFingerprintKey(rootKey: Buffer): Buffer {
  if (rootKey.byteLength !== 32) throw new Error("credential-encryption-key-invalid");
  return Buffer.from(
    hkdfSync(
      "sha256",
      rootKey,
      Buffer.from("prism-slack-app-configuration-fingerprint:v1", "utf8"),
      Buffer.from("environment-configuration-fingerprint-hmac:v1", "utf8"),
      32
    )
  );
}

export function environmentFingerprint(
  configuration: SlackOAuthServerConfig,
  key: Buffer | string
): string {
  const canonicalBundle = JSON.stringify([
    configuration.clientId,
    configuration.clientSecret,
    configuration.redirectUri,
    configuration.publicBaseUrl,
    configuration.botScopes,
    configuration.userScopes,
    configuration.mockOAuth
  ]);
  return createHmac("sha256", key).update(canonicalBundle).digest("hex");
}

function databaseSummary(
  configuration: RedactedSlackAppConfiguration,
  callbackUri: string
): EffectiveSlackAppConfigurationSummary {
  return {
    source: "database",
    environmentLocked: false,
    setupRequired: false,
    id: configuration.id,
    version: configuration.version,
    status: configuration.status,
    clientId: configuration.clientId,
    secretConfigured: true,
    botScopes: [...configuration.botScopes],
    userScopes: [...configuration.userScopes],
    socketModeEnabled: configuration.socketModeEnabled,
    socketApiAppId: configuration.socketApiAppId,
    socketAppTokenConfigured: configuration.socketAppTokenConfigured,
    callbackUri
  };
}

function cloneOAuthConfig(configuration: SlackOAuthServerConfig): SlackOAuthServerConfig {
  return {
    ...configuration,
    botScopes: [...configuration.botScopes],
    userScopes: [...configuration.userScopes]
  };
}

function equalFingerprint(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
