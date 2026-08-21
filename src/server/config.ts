import "server-only";

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

export type DeveloperTokenServerConfig = {
  pepper: string;
  pepperId: string;
};

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
  const clientId = requiredConfiguredValue(env.SLACK_CLIENT_ID, "SLACK_CLIENT_ID");
  const clientSecret = requiredConfiguredValue(env.SLACK_CLIENT_SECRET, "SLACK_CLIENT_SECRET");
  const configuredPublicBaseUrl = requiredConfiguredValue(env.PRISM_PUBLIC_BASE_URL, "PRISM_PUBLIC_BASE_URL");
  const publicBase = parsePublicBaseUrl(configuredPublicBaseUrl);
  validateHttpDeploymentUrl(publicBase, env, "PRISM_PUBLIC_BASE_URL");
  const publicBaseUrl = publicBase.toString().replace(/\/$/, "");
  const redirectUri =
    configuredValue(env.SLACK_OAUTH_REDIRECT_URI) ?? `${publicBaseUrl.replace(/\/$/, "")}/v1/slack/oauth/callback`;
  const parsedRedirectUri = parseSlackRedirectUri(redirectUri);
  validateHttpDeploymentUrl(parsedRedirectUri, env, "SLACK_OAUTH_REDIRECT_URI");

  const botScopes = parseScopes(env.SLACK_BOT_SCOPES) ?? [];
  const userScopes = parseScopes(env.SLACK_USER_SCOPES) ?? [];
  const mockOAuth = env.PRISM_SLACK_OAUTH_MOCK === "1" && env.NODE_ENV !== "production";
  if (!mockOAuth && botScopes.length === 0 && userScopes.length === 0) {
    throw new Error("setup-required:SLACK_OAUTH_SCOPES");
  }

  return {
    clientId,
    clientSecret,
    redirectUri: parsedRedirectUri.toString(),
    publicBaseUrl,
    // Slack's authorization request must explicitly carry the already-approved
    // scopes. These values select a subset; they do not grant app permissions.
    botScopes,
    userScopes,
    mockOAuth
  };
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
