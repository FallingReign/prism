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
  const publicBaseUrl = requiredConfiguredValue(env.PRISM_PUBLIC_BASE_URL, "PRISM_PUBLIC_BASE_URL");
  const redirectUri =
    configuredValue(env.SLACK_OAUTH_REDIRECT_URI) ?? `${publicBaseUrl.replace(/\/$/, "")}/v1/slack/oauth/callback`;

  return {
    clientId,
    clientSecret,
    redirectUri,
    publicBaseUrl,
    // Scopes are defined in the Slack app manifest, not in environment variables.
    // Leave these empty to use manifest-defined scopes. Only override if testing specific scope combinations.
    botScopes: parseScopes(env.SLACK_BOT_SCOPES) ?? [],
    userScopes: parseScopes(env.SLACK_USER_SCOPES) ?? [],
    mockOAuth: env.PRISM_SLACK_OAUTH_MOCK === "1" && env.NODE_ENV !== "production"
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
