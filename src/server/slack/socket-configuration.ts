import "server-only";

import type { CredentialCipher, CredentialEnvelope } from "../credentials/encryption";
import { createConfiguredCredentialCipher } from "../credentials/factory";
import type { Database } from "../db";
import { slackSocketAppTokenAad } from "./app-configuration-postgres-store";

export type SlackSocketConfiguration =
  | { enabled: false; source: "none"; apiAppId: null; appToken: null }
  | { enabled: true; source: "environment" | "database"; apiAppId: string; appToken: string };

type SocketConfigurationRow = {
  id: string;
  socket_mode_enabled: boolean;
  socket_api_app_id: string | null;
  socket_app_token_envelope: unknown;
};

export async function loadSlackSocketConfiguration({
  env = process.env,
  database,
  cipher
}: {
  env?: NodeJS.ProcessEnv;
  database: Database;
  cipher?: CredentialCipher;
}): Promise<SlackSocketConfiguration> {
  const environmentEnabled = env.SLACK_SOCKET_MODE_ENABLED?.trim() === "1";
  if (environmentEnabled) {
    const appToken = env.SLACK_APP_TOKEN?.trim() ?? "";
    const apiAppId = env.SLACK_API_APP_ID?.trim() ?? "";
    assertValid(appToken, apiAppId);
    return { enabled: true, source: "environment", apiAppId, appToken };
  }

  const result = await database.query<SocketConfigurationRow>(
    `select id, socket_mode_enabled, socket_api_app_id, socket_app_token_envelope
     from prism_slack_app_configuration_versions
     where status = 'active'
     order by activated_at desc, version desc
     limit 1`
  );
  const row = result.rows[0];
  if (!row?.socket_mode_enabled) return { enabled: false, source: "none", apiAppId: null, appToken: null };
  if (!row.socket_api_app_id || !isCredentialEnvelope(row.socket_app_token_envelope)) throw invalidConfiguration();
  const effectiveCipher = cipher ?? createConfiguredCredentialCipher();
  const appToken = await effectiveCipher.decrypt(row.socket_app_token_envelope, slackSocketAppTokenAad(row.id));
  assertValid(appToken, row.socket_api_app_id);
  return { enabled: true, source: "database", apiAppId: row.socket_api_app_id, appToken };
}

function assertValid(appToken: string, apiAppId: string): void {
  if (!/^xapp-[A-Za-z0-9-]{16,}$/.test(appToken) || !/^A[A-Z0-9]{8,31}$/.test(apiAppId)) throw invalidConfiguration();
}

function invalidConfiguration(): Error {
  return new Error("slack-socket-configuration-invalid");
}

function isCredentialEnvelope(value: unknown): value is CredentialEnvelope {
  if (!isRecord(value)) return false;
  return value.algorithm === "local-aes-256-gcm-v1"
    && typeof value.keyId === "string"
    && typeof value.iv === "string"
    && typeof value.tag === "string"
    && typeof value.ciphertext === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
