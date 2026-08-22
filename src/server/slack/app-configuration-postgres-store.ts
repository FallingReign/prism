import "server-only";

import { randomUUID } from "node:crypto";

import type { ActivityType } from "../audit/activity";
import { insertActivityAuditRecord } from "../audit/postgres-store";
import type { CredentialCipher, CredentialEnvelope } from "../credentials/encryption";
import type { Database } from "../db";
import {
  SlackAppConfigurationValidationError,
  canonicalizeSlackScopeSelection,
  redactSlackAppConfiguration,
  validateSlackAppConfigurationInput,
  type RedactedSlackAppConfiguration,
  type SlackAppConfigurationCreatedVia,
  type StoredSlackAppConfigurationVersion
} from "./app-configuration";

export type CreatePendingSlackAppConfigurationInput = {
  setupSessionId: string;
  expectedPendingVersionId?: string | null;
  clientId: unknown;
  clientSecret: unknown;
  botScopes?: readonly string[] | null;
  userScopes?: readonly string[] | null;
  createdVia: "bootstrap";
  createdByPrismUserId: null;
  now?: Date;
  audit: { endpoint: string; requestId: string };
};

export type ActivatePendingSlackAppConfigurationInput = {
  versionId: string;
  setupSessionId: string;
  activatedByPrismUserId: string;
  now?: Date;
  audit: { endpoint: string; requestId: string };
};

export type SlackAppConfigurationStore = {
  createPendingConfiguration(
    input: CreatePendingSlackAppConfigurationInput
  ): Promise<RedactedSlackAppConfiguration>;
  getActiveConfiguration(): Promise<StoredSlackAppConfigurationVersion | null>;
  getPendingConfigurationForSetupSession(input: {
    setupSessionId: string;
    now?: Date;
  }): Promise<StoredSlackAppConfigurationVersion | null>;
  getBoundConfiguration(input: {
    versionId: string;
    setupSessionId: string | null;
    now?: Date;
  }): Promise<StoredSlackAppConfigurationVersion | null>;
  /** Caller must construct this store with the callback transaction Database. */
  activatePendingConfigurationInTransaction(
    input: ActivatePendingSlackAppConfigurationInput
  ): Promise<RedactedSlackAppConfiguration>;
};

export class SlackAppConfigurationStoreError extends Error {
  readonly code:
    | "setup-session-unavailable"
    | "pending-conflict"
    | "configuration-unavailable"
    | "invalid-stored-configuration";

  constructor(code: SlackAppConfigurationStoreError["code"]) {
    super(`slack-app-configuration-store:${code}`);
    this.name = "SlackAppConfigurationStoreError";
    this.code = code;
  }
}

export function slackAppConfigurationSecretAad(versionId: string): string {
  return `prism-slack-app-configuration:${versionId}:client-secret`;
}

export function createPostgresSlackAppConfigurationStore(
  database: Database,
  cipher: CredentialCipher,
  options: { randomId?: () => string; production?: boolean } = {}
): SlackAppConfigurationStore {
  const randomId = options.randomId ?? randomUUID;
  const production = options.production ?? process.env.NODE_ENV === "production";

  return {
    async createPendingConfiguration(input) {
      let validated;
      try {
        validated = validateSlackAppConfigurationInput(input, { production });
      } catch (error) {
        if (error instanceof SlackAppConfigurationValidationError) throw error;
        throw new SlackAppConfigurationStoreError("configuration-unavailable");
      }
      const now = input.now ?? new Date();
      const versionId = randomId();

      try {
        return await database.transaction(async (tx) => {
          const setupSession = await tx.query<{ id: string }>(
            `select id
             from prism_setup_sessions
             where id = $1
               and purpose = 'initial_slack_configuration'
               and revoked_at is null
               and claimed_at is null
               and expires_at > $2
             for update`,
            [input.setupSessionId, now]
          );
          if (!setupSession.rows[0]) {
            throw new SlackAppConfigurationStoreError("setup-session-unavailable");
          }

          const current = await tx.query<{ id: string }>(
            `select id
             from prism_slack_app_configuration_versions
             where setup_session_id = $1 and status = 'pending'
             order by version desc
             limit 1
             for update`,
            [input.setupSessionId]
          );
          const currentId = current.rows[0]?.id ?? null;
          if (currentId !== (input.expectedPendingVersionId ?? null)) {
            throw new SlackAppConfigurationStoreError("pending-conflict");
          }

          if (currentId) {
            await tx.query(
              `update prism_slack_app_configuration_versions
               set status = 'superseded', superseded_at = $2
               where id = $1 and status = 'pending'`,
              [currentId, now]
            );
          }

          const clientSecretEnvelope = await cipher.encrypt(
            validated.clientSecret,
            slackAppConfigurationSecretAad(versionId)
          );
          const inserted = await tx.query<SlackAppConfigurationRow>(
            `insert into prism_slack_app_configuration_versions
               (id, status, client_id, client_secret_envelope, bot_scopes, user_scopes,
                created_via, created_by_prism_user_id, setup_session_id, created_at)
             values ($1, 'pending', $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
             returning id, version, status, client_id, client_secret_envelope,
                       bot_scopes, user_scopes, created_via, created_by_prism_user_id,
                       setup_session_id, created_at, activated_at, superseded_at`,
            [
              versionId,
              validated.clientId,
              JSON.stringify(clientSecretEnvelope),
              validated.botScopes,
              validated.userScopes,
              input.createdVia,
              input.createdByPrismUserId,
              input.setupSessionId,
              now
            ]
          );
          const stored = parseStoredConfiguration(inserted.rows[0]);

          await configurationAudit(tx, {
            activityType: "slack_configuration_candidate_created",
            prismUserId: input.createdByPrismUserId,
            versionId,
            executionMode: input.createdVia,
            status: "created",
            occurredAt: now,
            ...input.audit
          });
          return redactSlackAppConfiguration(stored);
        });
      } catch (error) {
        if (
          error instanceof SlackAppConfigurationStoreError ||
          error instanceof SlackAppConfigurationValidationError
        ) {
          throw error;
        }
        throw new SlackAppConfigurationStoreError("configuration-unavailable");
      }
    },

    async getActiveConfiguration() {
      try {
        const result = await database.query<SlackAppConfigurationRow>(
          `select id, version, status, client_id, client_secret_envelope,
                  bot_scopes, user_scopes, created_via, created_by_prism_user_id,
                  setup_session_id, created_at, activated_at, superseded_at
           from prism_slack_app_configuration_versions v
           where v.status = 'active'
           order by v.activated_at desc, v.version desc
           limit 1`
        );
        return result.rows[0] ? parseStoredConfiguration(result.rows[0]) : null;
      } catch (error) {
        if (error instanceof SlackAppConfigurationStoreError) throw error;
        throw new SlackAppConfigurationStoreError("configuration-unavailable");
      }
    },

    async getPendingConfigurationForSetupSession({ setupSessionId, now = new Date() }) {
      try {
        const result = await database.query<SlackAppConfigurationRow>(
          `select v.id, v.version, v.status, v.client_id, v.client_secret_envelope,
                  v.bot_scopes, v.user_scopes, v.created_via, v.created_by_prism_user_id,
                  v.setup_session_id, v.created_at, v.activated_at, v.superseded_at
           from prism_slack_app_configuration_versions v
           join prism_setup_sessions s on s.id = v.setup_session_id
           where v.setup_session_id = $1
             and v.status = 'pending'
             and s.purpose = 'initial_slack_configuration'
             and s.revoked_at is null
             and s.claimed_at is null
             and s.expires_at > $2
           order by v.version desc
           limit 1`,
          [setupSessionId, now]
        );
        return result.rows[0] ? parseStoredConfiguration(result.rows[0]) : null;
      } catch (error) {
        if (error instanceof SlackAppConfigurationStoreError) throw error;
        throw new SlackAppConfigurationStoreError("configuration-unavailable");
      }
    },

    async getBoundConfiguration({ versionId, setupSessionId, now = new Date() }) {
      try {
        const result = setupSessionId
          ? await database.query<SlackAppConfigurationRow>(
              `select v.id, v.version, v.status, v.client_id, v.client_secret_envelope,
                      v.bot_scopes, v.user_scopes, v.created_via, v.created_by_prism_user_id,
                      v.setup_session_id, v.created_at, v.activated_at, v.superseded_at
               from prism_slack_app_configuration_versions v
               join prism_setup_sessions s on s.id = v.setup_session_id
               where v.id = $1
                 and v.setup_session_id = $2
                 and v.status = 'pending'
                 and s.purpose = 'initial_slack_configuration'
                 and s.revoked_at is null
                 and s.claimed_at is null
                 and s.expires_at > $3
               limit 1`,
              [versionId, setupSessionId, now]
            )
          : await database.query<SlackAppConfigurationRow>(
              `select v.id, v.version, v.status, v.client_id, v.client_secret_envelope,
                      v.bot_scopes, v.user_scopes, v.created_via, v.created_by_prism_user_id,
                      v.setup_session_id, v.created_at, v.activated_at, v.superseded_at
               from prism_slack_app_configuration_versions v
               where v.id = $1 and v.status = 'active'
               limit 1`,
              [versionId]
            );
        return result.rows[0] ? parseStoredConfiguration(result.rows[0]) : null;
      } catch (error) {
        if (error instanceof SlackAppConfigurationStoreError) throw error;
        throw new SlackAppConfigurationStoreError("configuration-unavailable");
      }
    },

    async activatePendingConfigurationInTransaction({
      versionId,
      setupSessionId,
      activatedByPrismUserId,
      now = new Date(),
      audit
    }) {
      try {
        const locked = await database.query<SlackAppConfigurationRow>(
          `select v.id, v.version, v.status, v.client_id, v.client_secret_envelope,
                  v.bot_scopes, v.user_scopes, v.created_via, v.created_by_prism_user_id,
                  v.setup_session_id, v.created_at, v.activated_at, v.superseded_at
           from prism_slack_app_configuration_versions v
           join prism_setup_sessions s on s.id = v.setup_session_id
           where v.id = $1
             and v.setup_session_id = $2
             and v.status = 'pending'
             and s.purpose = 'initial_slack_configuration'
             and s.revoked_at is null
             and s.claimed_at is null
             and s.expires_at > $3
           for update`,
          [versionId, setupSessionId, now]
        );
        if (!locked.rows[0]) {
          throw new SlackAppConfigurationStoreError("configuration-unavailable");
        }

        await database.query(
          `update prism_slack_app_configuration_versions
           set status = 'superseded', superseded_at = $1
           where status = 'active' and id <> $2`,
          [now, versionId]
        );
        const activated = await database.query<SlackAppConfigurationRow>(
          `update prism_slack_app_configuration_versions
           set status = 'active', activated_at = $2, superseded_at = null
           where id = $1 and status = 'pending'
           returning id, version, status, client_id, client_secret_envelope,
                     bot_scopes, user_scopes, created_via, created_by_prism_user_id,
                     setup_session_id, created_at, activated_at, superseded_at`,
          [versionId, now]
        );
        const stored = parseStoredConfiguration(activated.rows[0]);

        await configurationAudit(database, {
          activityType: "slack_configuration_activated",
          prismUserId: activatedByPrismUserId,
          versionId,
          executionMode: "bootstrap",
          status: "updated",
          occurredAt: now,
          ...audit
        });
        return redactSlackAppConfiguration(stored);
      } catch (error) {
        if (error instanceof SlackAppConfigurationStoreError) throw error;
        throw new SlackAppConfigurationStoreError("configuration-unavailable");
      }
    }
  };
}

type SlackAppConfigurationRow = {
  id: string;
  version: string | number | bigint;
  status: "pending" | "active" | "superseded";
  client_id: string;
  client_secret_envelope: unknown;
  bot_scopes: unknown;
  user_scopes: unknown;
  created_via: SlackAppConfigurationCreatedVia;
  created_by_prism_user_id: string | null;
  setup_session_id: string | null;
  created_at: Date;
  activated_at: Date | null;
  superseded_at: Date | null;
};

function parseStoredConfiguration(
  row: SlackAppConfigurationRow | undefined
): StoredSlackAppConfigurationVersion {
  if (
    !row ||
    typeof row.id !== "string" ||
    !/^\d+$/.test(String(row.version)) ||
    !(row.status === "pending" || row.status === "active" || row.status === "superseded") ||
    typeof row.client_id !== "string" ||
    !(row.created_at instanceof Date) ||
    !isCredentialEnvelope(row.client_secret_envelope) ||
    !Array.isArray(row.bot_scopes) ||
    !Array.isArray(row.user_scopes)
  ) {
    throw new SlackAppConfigurationStoreError("invalid-stored-configuration");
  }
  let scopes;
  try {
    scopes = canonicalizeSlackScopeSelection({
      botScopes: row.bot_scopes,
      userScopes: row.user_scopes
    });
  } catch {
    throw new SlackAppConfigurationStoreError("invalid-stored-configuration");
  }
  return {
    id: row.id,
    version: String(row.version),
    status: row.status,
    clientId: row.client_id,
    clientSecretEnvelope: row.client_secret_envelope,
    botScopes: scopes.botScopes,
    userScopes: scopes.userScopes,
    createdVia: row.created_via,
    createdByPrismUserId: row.created_by_prism_user_id,
    setupSessionId: row.setup_session_id,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    supersededAt: row.superseded_at
  };
}

function isCredentialEnvelope(value: unknown): value is CredentialEnvelope {
  if (!isPlainRecord(value)) return false;
  return (
    value.algorithm === "local-aes-256-gcm-v1" &&
    typeof value.keyId === "string" &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.ciphertext === "string"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function configurationAudit(
  database: Database,
  input: {
    activityType: ActivityType;
    prismUserId: string | null;
    versionId: string;
    executionMode: SlackAppConfigurationCreatedVia;
    status: "created" | "updated";
    endpoint: string;
    requestId: string;
    occurredAt: Date;
  }
): Promise<void> {
  await insertActivityAuditRecord(database, {
    prismUserId: input.prismUserId,
    activityType: input.activityType,
    endpoint: input.endpoint,
    actionCategory: "settings",
    objectType: "slack_app_configuration",
    objectId: input.versionId,
    executionMode: input.executionMode,
    status: input.status,
    requestId: input.requestId,
    upstreamCalled: false,
    occurredAt: input.occurredAt
  });
}
