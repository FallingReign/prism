import "server-only";

import { createPublicKey } from "node:crypto";

import {
  SlackAppConfigurationValidationError,
  canonicalizeSlackScopeSelection
} from "./slack/app-configuration";

export type ServerConfig = {
  databaseUrl?: string;
};

export type SlackOAuthServerConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  publicBaseUrl: string;
  botScopes: string[];
  userScopes: string[];
  mockOAuth: boolean;
};

export type SlackWebApiConfig = {
  mockWebApi: boolean;
};

export type CredentialEncryptionConfig = {
  key: string;
  keyId: string;
};

export type SetupAbuseProtectionConfig = {
  trustProxyHeaders: boolean;
};

export type DeveloperTokenServerConfig = {
  pepper: string;
  pepperId: string;
};

export type SlackOAuthDeploymentConfig = Pick<
  SlackOAuthServerConfig,
  "redirectUri" | "publicBaseUrl"
>;

export type OidcClientConfig = {
  clientId: string;
  redirectUri: string;
  tokenEndpointAuthMethod: "none";
};

export type OidcSigningConfig = {
  privateKeyBase64: string;
  keyId: string;
};

export type OidcProviderConfig = {
  issuer: string;
  playtestClient: OidcClientConfig;
  signing: OidcSigningConfig;
  allowInsecureHttp: boolean;
  abuseProtection: OidcAbuseProtectionConfig;
};

export type OidcAbuseProtectionConfig = {
  authorizeWindowMs: number;
  maxAuthorizeRequestsPerSource: number;
  maxAuthorizeRequestsPerClient: number;
  maxOutstandingPendingPerSource: number;
  maxOutstandingPendingPerClient: number;
  cleanupBatchSize: number;
  trustProxyHeaders: boolean;
};

export type DelegatedDeliveryPublicJwk = {
  kty: "EC";
  crv: "P-256";
  alg: "ES256";
  kid: string;
  x: string;
  y: string;
  use?: "sig";
  key_ops?: ["verify"];
};

export type DelegatedDeliveryLimits = {
  approvalTtlMs: number;
  authorizationCodeTtlMs: number;
  maxScheduleHorizonMs: number;
  grantTtlMs: number;
  statusRetentionMs: number;
  proofClockSkewSeconds: number;
  proofLifetimeSeconds: number;
  rateWindowMs: number;
  maxRequestsPerSource: number;
  maxRequestsPerClient: number;
  maxRequestsPerUser: number;
  maxRequestsPerChannel: number;
  maxOutstandingPendingPerSource: number;
  maxOutstandingPendingPerClient: number;
  maxOutstandingPendingPerUser: number;
  cleanupBatchSize: number;
};

export type DelegatedDeliveryConfig =
  | { enabled: false }
  | {
      enabled: true;
      issuer: string;
      clientId: "shg-playtest-delegation";
      callbackUri: string;
      clientJwks: DelegatedDeliveryPublicJwk[];
      grantPepper: string;
      grantPepperId: string;
      allowInsecureHttp: boolean;
      trustProxyHeaders: boolean;
      limits: DelegatedDeliveryLimits;
    };

export type DelegatedDeliveryMaintenanceConfig = Pick<
  DelegatedDeliveryLimits,
  "statusRetentionMs" | "cleanupBatchSize"
>;

export const DELEGATED_DELIVERY_CLIENT_ID = "shg-playtest-delegation" as const;

const RESERVED_SLACK_OAUTH_MOCK_CLIENT_ID = "mock-playtest-client";

export const DEFAULT_DELEGATED_DELIVERY_LIMITS: DelegatedDeliveryLimits = {
  approvalTtlMs: 10 * 60_000,
  authorizationCodeTtlMs: 5 * 60_000,
  maxScheduleHorizonMs: 30 * 24 * 60 * 60_000,
  grantTtlMs: 30 * 60_000,
  statusRetentionMs: 30 * 24 * 60 * 60_000,
  proofClockSkewSeconds: 60,
  proofLifetimeSeconds: 60,
  rateWindowMs: 60_000,
  maxRequestsPerSource: 30,
  maxRequestsPerClient: 300,
  maxRequestsPerUser: 30,
  maxRequestsPerChannel: 60,
  maxOutstandingPendingPerSource: 10,
  maxOutstandingPendingPerClient: 500,
  maxOutstandingPendingPerUser: 20,
  cleanupBatchSize: 100
};

const MAX_DELEGATED_DELIVERY_LIMITS = {
  approvalTtlSeconds: 10 * 60,
  authorizationCodeTtlSeconds: 5 * 60,
  maxScheduleHorizonSeconds: 30 * 24 * 60 * 60,
  grantTtlSeconds: 30 * 60,
  statusRetentionSeconds: 30 * 24 * 60 * 60,
  proofClockSkewSeconds: 60,
  proofLifetimeSeconds: 60,
  rateWindowSeconds: 60 * 60,
  maxRequestsPerSource: 10_000,
  maxRequestsPerClient: 100_000,
  maxRequestsPerUser: 10_000,
  maxRequestsPerChannel: 10_000,
  maxOutstandingPendingPerSource: 10_000,
  maxOutstandingPendingPerClient: 100_000,
  maxOutstandingPendingPerUser: 10_000,
  cleanupBatchSize: 1000
} as const;

export const DEFAULT_OIDC_ABUSE_PROTECTION: OidcAbuseProtectionConfig = {
  authorizeWindowMs: 60_000,
  maxAuthorizeRequestsPerSource: 30,
  maxAuthorizeRequestsPerClient: 300,
  maxOutstandingPendingPerSource: 10,
  maxOutstandingPendingPerClient: 500,
  cleanupBatchSize: 100,
  trustProxyHeaders: false
};

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    databaseUrl: getDatabaseUrl(env)
  };
}

export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const directUrl = configuredValue(env.DATABASE_URL);
  if (directUrl) return directUrl;

  const user = configuredValue(env.POSTGRES_USER);
  const password = configuredValue(env.POSTGRES_PASSWORD);
  const database = configuredValue(env.POSTGRES_DB);
  if (!user || !password || !database) return undefined;

  const host = configuredValue(env.POSTGRES_HOST) ?? "localhost";
  const port = configuredValue(env.POSTGRES_PORT) ?? "5432";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

export function getSlackOAuthConfig(env: NodeJS.ProcessEnv = process.env): SlackOAuthServerConfig {
  const configuration = getSlackOAuthEnvironmentBundle(env);
  if (!configuration) throw new Error("setup-required:SLACK_CLIENT_ID");
  return configuration;
}

/**
 * Parses the legacy/secret-manager Slack bundle atomically. A complete pair is
 * authoritative; an absent pair permits the DB-backed configuration resolver;
 * and a partial pair never falls through to Postgres.
 */
export function getSlackOAuthEnvironmentBundle(
  env: NodeJS.ProcessEnv = process.env
): SlackOAuthServerConfig | null {
  const mockOAuthRequested = env.PRISM_SLACK_OAUTH_MOCK === "1";
  const clientId = configuredValue(env.SLACK_CLIENT_ID);
  const clientSecret = configuredValue(env.SLACK_CLIENT_SECRET);
  const production = env.NODE_ENV === "production";

  // Local development files can be loaded by `next start`. Treat only the
  // reserved, complete mock bundle (or a mock flag with no credentials) as
  // absent so it can never become a real Slack client and DB/setup may win.
  if (
    production &&
    ((clientId === RESERVED_SLACK_OAUTH_MOCK_CLIENT_ID && Boolean(clientSecret)) ||
      (mockOAuthRequested && !clientId && !clientSecret))
  ) {
    return null;
  }
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error("setup-required:SLACK_OAUTH_CREDENTIAL_PAIR");
  }
  if (!clientId || !clientSecret) {
    if (mockOAuthRequested) throw new Error("setup-required:SLACK_OAUTH_CREDENTIAL_PAIR");
    // Deployment URLs are validated when a DB configuration is resolved. Do
    // not let absent app credentials turn into an environment-owned bundle.
    return null;
  }
  if (production && mockOAuthRequested) {
    throw new Error("setup-required:PRISM_SLACK_OAUTH_MOCK");
  }
  const deployment = getSlackOAuthDeploymentConfig(env);

  // The built-in mock represents Prism's complete reviewed capability set.
  // Ignore stale local scope overrides in mock mode so a legacy .env.local
  // cannot block the database-backed setup UI before it is even reachable.
  const hasExplicitScopeSelection =
    !mockOAuthRequested &&
    (env.SLACK_BOT_SCOPES !== undefined || env.SLACK_USER_SCOPES !== undefined);
  let scopeSelection;
  try {
    scopeSelection = canonicalizeSlackScopeSelection(
      hasExplicitScopeSelection
        ? {
            botScopes: parseScopes(env.SLACK_BOT_SCOPES) ?? [],
            userScopes: parseScopes(env.SLACK_USER_SCOPES) ?? []
          }
        : undefined
    );
  } catch (error) {
    if (error instanceof SlackAppConfigurationValidationError) {
      throw new Error("setup-required:SLACK_OAUTH_SCOPES");
    }
    throw error;
  }

  return {
    clientId,
    clientSecret,
    redirectUri: deployment.redirectUri,
    publicBaseUrl: deployment.publicBaseUrl,
    // Slack's authorization request must explicitly carry the already-approved
    // scopes. These values select a subset; they do not grant app permissions.
    botScopes: scopeSelection.botScopes,
    userScopes: scopeSelection.userScopes,
    mockOAuth: mockOAuthRequested
  };
}

export function getSlackOAuthDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env
): SlackOAuthDeploymentConfig {
  const configuredPublicBaseUrl = requiredConfiguredValue(
    env.PRISM_PUBLIC_BASE_URL,
    "PRISM_PUBLIC_BASE_URL"
  );
  const publicBase = parsePublicBaseUrl(configuredPublicBaseUrl);
  validateHttpDeploymentUrl(publicBase, env, "PRISM_PUBLIC_BASE_URL");
  const publicBaseUrl = publicBase.toString().replace(/\/$/, "");
  const redirectUri =
    configuredValue(env.SLACK_OAUTH_REDIRECT_URI) ??
    `${publicBaseUrl}/v1/slack/oauth/callback`;
  const parsedRedirectUri = parseSlackRedirectUri(redirectUri);
  validateHttpDeploymentUrl(parsedRedirectUri, env, "SLACK_OAUTH_REDIRECT_URI");
  return { publicBaseUrl, redirectUri: parsedRedirectUri.toString() };
}

export function getSlackWebApiConfig(env: NodeJS.ProcessEnv = process.env): SlackWebApiConfig {
  return {
    mockWebApi: env.PRISM_SLACK_WEB_API_MOCK === "1" && env.NODE_ENV !== "production"
  };
}

export function getCredentialEncryptionConfig(env: NodeJS.ProcessEnv = process.env): CredentialEncryptionConfig {
  return {
    key: requiredConfiguredValue(env.PRISM_CREDENTIAL_ENCRYPTION_KEY, "PRISM_CREDENTIAL_ENCRYPTION_KEY"),
    keyId: requiredConfiguredValue(env.PRISM_CREDENTIAL_ENCRYPTION_KEY_ID, "PRISM_CREDENTIAL_ENCRYPTION_KEY_ID")
  };
}

export function getDeveloperTokenConfig(env: NodeJS.ProcessEnv = process.env): DeveloperTokenServerConfig {
  return {
    pepper: requiredConfiguredValue(env.PRISM_DEVELOPER_TOKEN_PEPPER, "PRISM_DEVELOPER_TOKEN_PEPPER"),
    pepperId: configuredValue(env.PRISM_DEVELOPER_TOKEN_PEPPER_ID) ?? "local-dev-pepper-v1"
  };
}

export function getSetupAbuseProtectionConfig(
  env: NodeJS.ProcessEnv = process.env
): SetupAbuseProtectionConfig {
  return {
    trustProxyHeaders: env.PRISM_SETUP_TRUST_PROXY_HEADERS === "1"
  };
}

export function getDelegatedDeliveryConfig(env: NodeJS.ProcessEnv = process.env): DelegatedDeliveryConfig {
  if (env.PRISM_DELEGATED_SLACK_DELIVERY_ENABLED !== "1") {
    return { enabled: false };
  }

  const clientId = requiredConfiguredValue(
    env.PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID,
    "PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID"
  );
  if (clientId !== DELEGATED_DELIVERY_CLIENT_ID) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID");
  }

  const allowInsecureHttp =
    env.NODE_ENV !== "production" && env.PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP === "1";
  const baseUrl = parsePublicBaseUrl(
    requiredConfiguredValue(env.PRISM_PUBLIC_BASE_URL, "PRISM_PUBLIC_BASE_URL")
  );
  validateDelegatedDeliveryUrl(baseUrl, env, "PRISM_PUBLIC_BASE_URL", allowInsecureHttp);

  const callbackUri = parseExactCallbackUri(
    requiredConfiguredValue(
      env.PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI,
      "PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI"
    ),
    "PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI"
  );
  validateDelegatedDeliveryUrl(
    callbackUri,
    env,
    "PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI",
    allowInsecureHttp
  );

  const grantPepper = requiredConfiguredValue(
    env.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER,
    "PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER"
  );
  if (Buffer.byteLength(grantPepper, "utf8") < 32 || Buffer.byteLength(grantPepper, "utf8") > 4096) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER");
  }
  if (configuredValue(env.PRISM_DEVELOPER_TOKEN_PEPPER) === grantPepper) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_DISTINCT");
  }

  const grantPepperId = requiredConfiguredValue(
    env.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID,
    "PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID"
  );
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(grantPepperId)) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID");
  }
  if (configuredValue(env.PRISM_DEVELOPER_TOKEN_PEPPER_ID) === grantPepperId) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID_DISTINCT");
  }

  return {
    enabled: true,
    issuer: baseUrl.toString().replace(/\/$/, ""),
    clientId: DELEGATED_DELIVERY_CLIENT_ID,
    callbackUri: callbackUri.toString(),
    clientJwks: parseDelegatedDeliveryClientJwks(env.PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS),
    grantPepper,
    grantPepperId,
    allowInsecureHttp,
    trustProxyHeaders:
      env.PRISM_DELEGATED_SLACK_DELIVERY_TRUST_PROXY_HEADERS === "1",
    limits: getDelegatedDeliveryLimits(env)
  };
}

export function getDelegatedDeliveryMaintenanceConfig(
  env: NodeJS.ProcessEnv = process.env
): DelegatedDeliveryMaintenanceConfig {
  return {
    statusRetentionMs:
      configuredInteger(
        env.PRISM_DELEGATED_SLACK_DELIVERY_STATUS_RETENTION_SECONDS,
        "PRISM_DELEGATED_SLACK_DELIVERY_STATUS_RETENTION_SECONDS",
        DEFAULT_DELEGATED_DELIVERY_LIMITS.statusRetentionMs / 1000,
        1,
        MAX_DELEGATED_DELIVERY_LIMITS.statusRetentionSeconds
      ) * 1000,
    cleanupBatchSize: configuredInteger(
      env.PRISM_DELEGATED_SLACK_DELIVERY_CLEANUP_BATCH_SIZE,
      "PRISM_DELEGATED_SLACK_DELIVERY_CLEANUP_BATCH_SIZE",
      DEFAULT_DELEGATED_DELIVERY_LIMITS.cleanupBatchSize,
      1,
      MAX_DELEGATED_DELIVERY_LIMITS.cleanupBatchSize
    )
  };
}

function getDelegatedDeliveryLimits(env: NodeJS.ProcessEnv): DelegatedDeliveryLimits {
  const approvalTtlSeconds = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_APPROVAL_TTL_SECONDS,
    "PRISM_DELEGATED_SLACK_DELIVERY_APPROVAL_TTL_SECONDS",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.approvalTtlMs / 1000,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.approvalTtlSeconds
  );
  const authorizationCodeTtlSeconds = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_CODE_TTL_SECONDS,
    "PRISM_DELEGATED_SLACK_DELIVERY_CODE_TTL_SECONDS",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.authorizationCodeTtlMs / 1000,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.authorizationCodeTtlSeconds
  );
  const maxScheduleHorizonSeconds = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_MAX_SCHEDULE_HORIZON_SECONDS,
    "PRISM_DELEGATED_SLACK_DELIVERY_MAX_SCHEDULE_HORIZON_SECONDS",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.maxScheduleHorizonMs / 1000,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.maxScheduleHorizonSeconds
  );
  const grantTtlSeconds = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_TTL_SECONDS,
    "PRISM_DELEGATED_SLACK_DELIVERY_GRANT_TTL_SECONDS",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.grantTtlMs / 1000,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.grantTtlSeconds
  );
  const maintenance = getDelegatedDeliveryMaintenanceConfig(env);
  const proofClockSkewSeconds = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_PROOF_CLOCK_SKEW_SECONDS,
    "PRISM_DELEGATED_SLACK_DELIVERY_PROOF_CLOCK_SKEW_SECONDS",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.proofClockSkewSeconds,
    0,
    MAX_DELEGATED_DELIVERY_LIMITS.proofClockSkewSeconds
  );
  const proofLifetimeSeconds = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_PROOF_LIFETIME_SECONDS,
    "PRISM_DELEGATED_SLACK_DELIVERY_PROOF_LIFETIME_SECONDS",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.proofLifetimeSeconds,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.proofLifetimeSeconds
  );
  const rateWindowSeconds = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_RATE_WINDOW_SECONDS,
    "PRISM_DELEGATED_SLACK_DELIVERY_RATE_WINDOW_SECONDS",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.rateWindowMs / 1000,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.rateWindowSeconds
  );
  const maxRequestsPerSource = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_RATE_LIMIT_PER_SOURCE,
    "PRISM_DELEGATED_SLACK_DELIVERY_RATE_LIMIT_PER_SOURCE",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.maxRequestsPerSource,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.maxRequestsPerSource
  );
  const maxRequestsPerClient = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_RATE_LIMIT_PER_CLIENT,
    "PRISM_DELEGATED_SLACK_DELIVERY_RATE_LIMIT_PER_CLIENT",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.maxRequestsPerClient,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.maxRequestsPerClient
  );
  const maxRequestsPerUser = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_RATE_LIMIT_PER_USER,
    "PRISM_DELEGATED_SLACK_DELIVERY_RATE_LIMIT_PER_USER",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.maxRequestsPerUser,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.maxRequestsPerUser
  );
  const maxRequestsPerChannel = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_RATE_LIMIT_PER_CHANNEL,
    "PRISM_DELEGATED_SLACK_DELIVERY_RATE_LIMIT_PER_CHANNEL",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.maxRequestsPerChannel,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.maxRequestsPerChannel
  );
  const maxOutstandingPendingPerSource = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_MAX_OUTSTANDING_PER_SOURCE,
    "PRISM_DELEGATED_SLACK_DELIVERY_MAX_OUTSTANDING_PER_SOURCE",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.maxOutstandingPendingPerSource,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.maxOutstandingPendingPerSource
  );
  const maxOutstandingPendingPerClient = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_MAX_OUTSTANDING_PER_CLIENT,
    "PRISM_DELEGATED_SLACK_DELIVERY_MAX_OUTSTANDING_PER_CLIENT",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.maxOutstandingPendingPerClient,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.maxOutstandingPendingPerClient
  );
  const maxOutstandingPendingPerUser = configuredInteger(
    env.PRISM_DELEGATED_SLACK_DELIVERY_MAX_OUTSTANDING_PER_USER,
    "PRISM_DELEGATED_SLACK_DELIVERY_MAX_OUTSTANDING_PER_USER",
    DEFAULT_DELEGATED_DELIVERY_LIMITS.maxOutstandingPendingPerUser,
    1,
    MAX_DELEGATED_DELIVERY_LIMITS.maxOutstandingPendingPerUser
  );

  if (authorizationCodeTtlSeconds > approvalTtlSeconds || grantTtlSeconds <= approvalTtlSeconds) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_TIMING_LIMITS");
  }
  if (
    maxRequestsPerClient < maxRequestsPerSource ||
    maxRequestsPerClient < maxRequestsPerUser ||
    maxRequestsPerClient < maxRequestsPerChannel ||
    maxOutstandingPendingPerClient < maxOutstandingPendingPerSource ||
    maxOutstandingPendingPerClient < maxOutstandingPendingPerUser
  ) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_ABUSE_PROTECTION_LIMITS");
  }

  return {
    approvalTtlMs: approvalTtlSeconds * 1000,
    authorizationCodeTtlMs: authorizationCodeTtlSeconds * 1000,
    maxScheduleHorizonMs: maxScheduleHorizonSeconds * 1000,
    grantTtlMs: grantTtlSeconds * 1000,
    statusRetentionMs: maintenance.statusRetentionMs,
    proofClockSkewSeconds,
    proofLifetimeSeconds,
    rateWindowMs: rateWindowSeconds * 1000,
    maxRequestsPerSource,
    maxRequestsPerClient,
    maxRequestsPerUser,
    maxRequestsPerChannel,
    maxOutstandingPendingPerSource,
    maxOutstandingPendingPerClient,
    maxOutstandingPendingPerUser,
    cleanupBatchSize: maintenance.cleanupBatchSize
  };
}

export function getOidcProviderConfig(env: NodeJS.ProcessEnv = process.env): OidcProviderConfig {
  const publicBaseUrl = requiredConfiguredValue(env.PRISM_PUBLIC_BASE_URL, "PRISM_PUBLIC_BASE_URL");
  const baseUrl = parsePublicBaseUrl(publicBaseUrl);
  const insecureHttpRequested = env.PRISM_OIDC_ALLOW_INSECURE_HTTP === "1";
  const allowInsecureHttp = env.NODE_ENV !== "production" && insecureHttpRequested;
  validateHttpDeploymentUrl(baseUrl, env, "PRISM_PUBLIC_BASE_URL");

  const redirectUri = requiredConfiguredValue(env.PRISM_OIDC_PLAYTEST_REDIRECT_URI, "PRISM_OIDC_PLAYTEST_REDIRECT_URI");
  const parsedRedirectUri = parseRedirectUri(redirectUri);
  validateHttpDeploymentUrl(parsedRedirectUri, env, "PRISM_OIDC_PLAYTEST_REDIRECT_URI");

  const clientId = requiredConfiguredValue(env.PRISM_OIDC_PLAYTEST_CLIENT_ID, "PRISM_OIDC_PLAYTEST_CLIENT_ID");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) {
    throw new Error("setup-required:PRISM_OIDC_PLAYTEST_CLIENT_ID");
  }

  const privateKeyBase64 = requiredConfiguredValue(
    env.PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64,
    "PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64"
  );
  if (!isBase64PrivateKeyEnvelope(privateKeyBase64)) {
    throw new Error("setup-required:PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64");
  }

  const keyId = requiredConfiguredValue(env.PRISM_OIDC_SIGNING_KEY_ID, "PRISM_OIDC_SIGNING_KEY_ID");
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(keyId)) {
    throw new Error("setup-required:PRISM_OIDC_SIGNING_KEY_ID");
  }

  const abuseProtection = getOidcAbuseProtectionConfig(env);

  return {
    issuer: baseUrl.toString().replace(/\/$/, ""),
    playtestClient: { clientId, redirectUri: parsedRedirectUri.toString(), tokenEndpointAuthMethod: "none" },
    signing: { privateKeyBase64, keyId },
    allowInsecureHttp,
    abuseProtection
  };
}

function getOidcAbuseProtectionConfig(env: NodeJS.ProcessEnv): OidcAbuseProtectionConfig {
  const authorizeWindowSeconds = configuredInteger(
    env.PRISM_OIDC_AUTHORIZE_RATE_WINDOW_SECONDS,
    "PRISM_OIDC_AUTHORIZE_RATE_WINDOW_SECONDS",
    DEFAULT_OIDC_ABUSE_PROTECTION.authorizeWindowMs / 1000,
    1,
    3600
  );
  const maxAuthorizeRequestsPerSource = configuredInteger(
    env.PRISM_OIDC_AUTHORIZE_RATE_LIMIT_PER_SOURCE,
    "PRISM_OIDC_AUTHORIZE_RATE_LIMIT_PER_SOURCE",
    DEFAULT_OIDC_ABUSE_PROTECTION.maxAuthorizeRequestsPerSource,
    1,
    10_000
  );
  const maxAuthorizeRequestsPerClient = configuredInteger(
    env.PRISM_OIDC_AUTHORIZE_RATE_LIMIT_PER_CLIENT,
    "PRISM_OIDC_AUTHORIZE_RATE_LIMIT_PER_CLIENT",
    DEFAULT_OIDC_ABUSE_PROTECTION.maxAuthorizeRequestsPerClient,
    1,
    100_000
  );
  const maxOutstandingPendingPerSource = configuredInteger(
    env.PRISM_OIDC_AUTHORIZE_MAX_OUTSTANDING_PER_SOURCE,
    "PRISM_OIDC_AUTHORIZE_MAX_OUTSTANDING_PER_SOURCE",
    DEFAULT_OIDC_ABUSE_PROTECTION.maxOutstandingPendingPerSource,
    1,
    10_000
  );
  const maxOutstandingPendingPerClient = configuredInteger(
    env.PRISM_OIDC_AUTHORIZE_MAX_OUTSTANDING_PER_CLIENT,
    "PRISM_OIDC_AUTHORIZE_MAX_OUTSTANDING_PER_CLIENT",
    DEFAULT_OIDC_ABUSE_PROTECTION.maxOutstandingPendingPerClient,
    1,
    100_000
  );
  const cleanupBatchSize = configuredInteger(
    env.PRISM_OIDC_CLEANUP_BATCH_SIZE,
    "PRISM_OIDC_CLEANUP_BATCH_SIZE",
    DEFAULT_OIDC_ABUSE_PROTECTION.cleanupBatchSize,
    1,
    1000
  );
  if (
    maxAuthorizeRequestsPerClient < maxAuthorizeRequestsPerSource ||
    maxOutstandingPendingPerClient < maxOutstandingPendingPerSource
  ) {
    throw new Error("setup-required:PRISM_OIDC_ABUSE_PROTECTION_LIMITS");
  }
  return {
    authorizeWindowMs: authorizeWindowSeconds * 1000,
    maxAuthorizeRequestsPerSource,
    maxAuthorizeRequestsPerClient,
    maxOutstandingPendingPerSource,
    maxOutstandingPendingPerClient,
    cleanupBatchSize,
    trustProxyHeaders: env.PRISM_OIDC_TRUST_PROXY_HEADERS === "1"
  };
}

export function isSetupRequiredError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("setup-required:");
}

function parseScopes(value: string | undefined): string[] | undefined {
  const configured = configuredValue(value);
  return configured?.split(",").map((scope) => scope.trim()).filter(Boolean);
}

function requiredConfiguredValue(value: string | undefined, name: string): string {
  const configured = configuredValue(value);
  if (!configured) {
    throw new Error(`setup-required:${name}`);
  }
  return configured;
}

function configuredValue(value: string | undefined): string | undefined {
  if (!value || value.includes("replace-with")) return undefined;
  return value;
}

function configuredInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const configured = configuredValue(value);
  if (!configured) return fallback;
  if (!/^\d+$/.test(configured)) throw new Error(`setup-required:${name}`);
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`setup-required:${name}`);
  }
  return parsed;
}

function parseDelegatedDeliveryClientJwks(value: string | undefined): DelegatedDeliveryPublicJwk[] {
  const raw = requiredConfiguredValue(value, "PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS");
  }

  if (!isPlainRecord(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.keys)) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS");
  }
  if (parsed.keys.length < 1 || parsed.keys.length > 5) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS");
  }

  const kids = new Set<string>();
  return parsed.keys.map((candidate) => {
    const jwk = parseDelegatedDeliveryClientJwk(candidate);
    if (kids.has(jwk.kid)) {
      throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS");
    }
    kids.add(jwk.kid);
    return jwk;
  });
}

function parseDelegatedDeliveryClientJwk(value: unknown): DelegatedDeliveryPublicJwk {
  const allowedFields = new Set(["kty", "crv", "alg", "kid", "x", "y", "use", "key_ops"]);
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !allowedFields.has(key)) ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    value.alg !== "ES256" ||
    typeof value.kid !== "string" ||
    !/^[A-Za-z0-9._~-]{1,128}$/.test(value.kid) ||
    typeof value.x !== "string" ||
    !isP256Coordinate(value.x) ||
    typeof value.y !== "string" ||
    !isP256Coordinate(value.y) ||
    (value.use !== undefined && value.use !== "sig") ||
    (value.key_ops !== undefined &&
      (!Array.isArray(value.key_ops) || value.key_ops.length !== 1 || value.key_ops[0] !== "verify"))
  ) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS");
  }

  const jwk: DelegatedDeliveryPublicJwk = {
    kty: "EC",
    crv: "P-256",
    alg: "ES256",
    kid: value.kid,
    x: value.x,
    y: value.y
  };
  if (value.use === "sig") jwk.use = "sig";
  if (Array.isArray(value.key_ops)) jwk.key_ops = ["verify"];

  try {
    createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
  } catch {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS");
  }
  return jwk;
}

function isP256Coordinate(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, "base64url").byteLength === 32;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function parseExactCallbackUri(value: string, name: string): URL {
  if (/[\u0000-\u001f\u007f\\]/.test(value)) throw new Error(`setup-required:${name}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`setup-required:${name}`);
  }
  if (
    !(url.protocol === "http:" || url.protocol === "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/"
  ) {
    throw new Error(`setup-required:${name}`);
  }
  return url;
}

function validateDelegatedDeliveryUrl(
  url: URL,
  env: NodeJS.ProcessEnv,
  name: string,
  allowInsecureHttp: boolean
): void {
  if (env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error(`setup-required:${name}_HTTPS`);
  }
  if (url.protocol === "http:" && (!allowInsecureHttp || !isAllowedInsecureHttpHost(url.hostname))) {
    throw new Error("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP");
  }
}

function parsePublicBaseUrl(value: string): URL {
  if (/[\u0000-\u001f\u007f\\]/.test(value)) throw new Error("setup-required:PRISM_PUBLIC_BASE_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("setup-required:PRISM_PUBLIC_BASE_URL");
  }
  if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("setup-required:PRISM_PUBLIC_BASE_URL");
  }
  return url;
}

function parseSlackRedirectUri(value: string): URL {
  if (/[\u0000-\u001f\u007f\\]/.test(value)) throw new Error("setup-required:SLACK_OAUTH_REDIRECT_URI");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("setup-required:SLACK_OAUTH_REDIRECT_URI");
  }
  if (!(url.protocol === "http:" || url.protocol === "https:") || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname === "/") {
    throw new Error("setup-required:SLACK_OAUTH_REDIRECT_URI");
  }
  return url;
}

function parseRedirectUri(value: string): URL {
  if (/[\u0000-\u001f\u007f\\]/.test(value)) throw new Error("setup-required:PRISM_OIDC_PLAYTEST_REDIRECT_URI");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("setup-required:PRISM_OIDC_PLAYTEST_REDIRECT_URI");
  }
  if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname || url.username || url.password || url.hash || url.search || url.pathname === "/") {
    throw new Error("setup-required:PRISM_OIDC_PLAYTEST_REDIRECT_URI");
  }
  return url;
}

function isBase64PrivateKeyEnvelope(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const pem = Buffer.from(value, "base64").toString("utf8");
  return pem.startsWith("-----BEGIN PRIVATE KEY-----") && pem.includes("-----END PRIVATE KEY-----");
}

function isAllowedInsecureHttpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;

  const octets = normalized.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 127
  );
}

function validateHttpDeploymentUrl(url: URL, env: NodeJS.ProcessEnv, name: string): void {
  if (env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error(`setup-required:${name}_HTTPS`);
  }
  const allowInsecureHttp = env.NODE_ENV !== "production" && env.PRISM_OIDC_ALLOW_INSECURE_HTTP === "1";
  if (url.protocol === "http:" && (!allowInsecureHttp || !isAllowedInsecureHttpHost(url.hostname))) {
    throw new Error("setup-required:PRISM_OIDC_ALLOW_INSECURE_HTTP");
  }
}
