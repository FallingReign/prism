export const REQUIRED_BOOTSTRAP_ENV = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "PRISM_PUBLIC_BASE_URL",
  "SLACK_OAUTH_REDIRECT_URI",
  "PRISM_OIDC_PLAYTEST_CLIENT_ID",
  "PRISM_OIDC_PLAYTEST_REDIRECT_URI",
  "PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64",
  "PRISM_OIDC_SIGNING_KEY_ID",
  "PRISM_CREDENTIAL_ENCRYPTION_KEY",
  "PRISM_CREDENTIAL_ENCRYPTION_KEY_ID",
  "PRISM_DEVELOPER_TOKEN_PEPPER",
  "PRISM_DEVELOPER_TOKEN_PEPPER_ID",
];

export function configuredValue(value) {
  if (!value || value.includes("replace-with")) return undefined;
  return value;
}

export function missingBootstrapConfiguration(env) {
  return REQUIRED_BOOTSTRAP_ENV.filter((name) => !configuredValue(env[name]));
}
