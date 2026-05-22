import type { AdapterConfig } from "./types.js";

const slackCredentialEnvNames = [
  "SLACK_BOT_TOKEN",
  "SLACK_USER_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_REFRESH_TOKEN",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET"
];

export function readAdapterConfig(env: NodeJS.ProcessEnv): AdapterConfig {
  const slackCredentialNames = slackCredentialEnvNames.filter((name) => Boolean(env[name]));
  if (slackCredentialNames.length > 0) {
    throw new Error(`Slack credential-like environment variables are not allowed: ${slackCredentialNames.join(", ")}`);
  }

  const baseUrl = configured(env.PRISM_BASE_URL);
  const developerToken = configured(env.PRISM_DEVELOPER_TOKEN);
  if (!baseUrl) throw new Error("PRISM_BASE_URL is required");
  if (!developerToken) throw new Error("PRISM_DEVELOPER_TOKEN is required");
  if (!/^prism_dev_[A-Za-z0-9_-]{32,}$/.test(developerToken)) throw new Error("PRISM_DEVELOPER_TOKEN must be a Prism developer token");

  return {
    baseUrl: new URL(baseUrl).toString().replace(/\/+$/, ""),
    developerToken
  };
}

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
