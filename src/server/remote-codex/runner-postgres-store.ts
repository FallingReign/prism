import "server-only";

import { timingSafeEqual } from "node:crypto";

import type { Database } from "../db";
import type { CredentialRefreshStore } from "./credential-refresh";
import type { RunnerAccessIdentity, RunnerAuthStore } from "./runner-auth";
import type { SessionCatalogStore } from "./session-service";

type RunnerAccessRow = {
  installation_id: string;
  prism_user_id: string;
  slack_connection_id: string;
  signing_public_key: string;
};

type RefreshRow = {
  installation_id: string;
  signing_public_key: string;
  refresh_token_hash: string;
  refresh_family_id: string;
  refresh_rotation: number;
  refresh_token_expires_at: Date | string;
};

export function createPostgresRunnerAuthStore(database: Database): RunnerAuthStore {
  return {
    async resolveAccess({ installationId, accessTokenHash, now }) {
      const result = await database.query<RunnerAccessRow>(
        `select i.id as installation_id, i.prism_user_id, i.slack_connection_id, i.signing_public_key
           from remote_codex_installations i
           join remote_codex_installation_credentials c on c.installation_id = i.id
          where i.id = $1 and c.access_token_hash = $2 and c.access_token_expires_at > $3
            and i.revoked_at is null and c.revoked_at is null and i.state <> 'revoked'`,
        [installationId, accessTokenHash, now]
      );
      return result.rows[0] ? mapRunnerAccess(result.rows[0]) : null;
    },

    async claimNonce(input) {
      return database.transaction(async (transaction) => {
        await transaction.query(`delete from remote_codex_request_nonces where expires_at < $1`, [input.now]);
        const claimed = await transaction.query(
          `insert into remote_codex_request_nonces
             (installation_id, nonce, request_timestamp, expires_at)
           values ($1, $2, $3, $4)
           on conflict do nothing`,
          [input.installationId, input.nonce, input.requestTimestamp, input.expiresAt]
        );
        if (claimed.rowCount !== 1) return false;
        await transaction.query(
          `update remote_codex_installations
              set state = 'online', last_seen_at = $2, updated_at = $2
            where id = $1 and revoked_at is null`,
          [input.installationId, input.now]
        );
        return true;
      });
    }
  };
}

export function createPostgresSessionCatalogStore(database: Database): SessionCatalogStore {
  return {
    async replaceCatalog(input) {
      await database.transaction(async (transaction) => {
        for (const session of input.sessions) {
          await transaction.query(
            `insert into remote_codex_sessions
               (installation_id, codex_thread_id, safe_title, project_label, status,
                last_activity_at, catalog_version, last_seen_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             on conflict (installation_id, codex_thread_id) do update
               set safe_title = excluded.safe_title,
                   project_label = excluded.project_label,
                   status = excluded.status,
                   last_activity_at = excluded.last_activity_at,
                   catalog_version = excluded.catalog_version,
                   last_seen_at = excluded.last_seen_at,
                   updated_at = excluded.last_seen_at`,
            [
              input.installationId,
              session.threadId,
              session.title,
              session.projectLabel,
              session.status,
              session.lastActivity,
              input.catalogVersion,
              input.now
            ]
          );
        }
        await transaction.query(
          `update remote_codex_sessions
              set status = 'unavailable', updated_at = $3
            where installation_id = $1 and catalog_version <> $2 and status <> 'unavailable'`,
          [input.installationId, input.catalogVersion, input.now]
        );
        await transaction.query(
          `update remote_codex_installations
              set state = 'online', last_seen_at = $2, updated_at = $2
            where id = $1 and revoked_at is null`,
          [input.installationId, input.now]
        );
      });
    }
  };
}

export function createPostgresCredentialRefreshStore(database: Database): CredentialRefreshStore {
  return {
    async read({ installationId, now }) {
      const result = await database.query<RefreshRow>(
        `select i.id as installation_id, i.signing_public_key, c.refresh_token_hash,
                c.refresh_family_id, c.refresh_rotation, c.refresh_token_expires_at
           from remote_codex_installations i
           join remote_codex_installation_credentials c on c.installation_id = i.id
          where i.id = $1 and i.revoked_at is null and c.revoked_at is null
            and c.refresh_token_expires_at > $2`,
        [installationId, now]
      );
      const row = result.rows[0];
      return row
        ? {
            installationId: row.installation_id,
            signingPublicKey: row.signing_public_key,
            refreshTokenHash: row.refresh_token_hash,
            refreshTokenExpiresAt: new Date(row.refresh_token_expires_at)
          }
        : null;
    },

    async rotate(input) {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<RefreshRow>(
          `select i.id as installation_id, i.signing_public_key, c.refresh_token_hash,
                  c.refresh_family_id, c.refresh_rotation, c.refresh_token_expires_at
             from remote_codex_installations i
             join remote_codex_installation_credentials c on c.installation_id = i.id
            where i.id = $1 and i.revoked_at is null and c.revoked_at is null
            for update of c, i`,
          [input.installationId]
        );
        const current = result.rows[0];
        if (!current || new Date(current.refresh_token_expires_at).getTime() <= input.now.getTime()) return "invalid";
        if (!safeHashEqual(current.refresh_token_hash, input.presentedRefreshTokenHash)) {
          const reuse = await transaction.query(
            `select 1
               from remote_codex_refresh_token_history
              where installation_id = $1 and refresh_token_hash = $2`,
            [input.installationId, input.presentedRefreshTokenHash]
          );
          if (!reuse.rows[0]) return "invalid";
          await transaction.query(
            `update remote_codex_installations
                set state = 'revoked', revoked_at = $2, updated_at = $2
              where id = $1`,
            [input.installationId, input.now]
          );
          await transaction.query(
            `update remote_codex_installation_credentials
                set revoked_at = $2, updated_at = $2
              where installation_id = $1`,
            [input.installationId, input.now]
          );
          return "reused";
        }

        await transaction.query(
          `insert into remote_codex_refresh_token_history
             (installation_id, refresh_family_id, refresh_token_hash, rotation, used_at)
           values ($1, $2, $3, $4, $5)`,
          [input.installationId, current.refresh_family_id, current.refresh_token_hash, current.refresh_rotation, input.now]
        );
        const updated = await transaction.query(
          `update remote_codex_installation_credentials
              set access_token_hash = $2, access_token_expires_at = $3,
                  refresh_token_hash = $4, refresh_rotation = refresh_rotation + 1,
                  refresh_token_expires_at = $5, updated_at = $6
            where installation_id = $1 and refresh_token_hash = $7 and revoked_at is null`,
          [
            input.installationId,
            input.nextAccessTokenHash,
            input.nextAccessTokenExpiresAt,
            input.nextRefreshTokenHash,
            input.nextRefreshTokenExpiresAt,
            input.now,
            input.presentedRefreshTokenHash
          ]
        );
        return updated.rowCount === 1 ? "rotated" : "invalid";
      });
    }
  };
}

function mapRunnerAccess(row: RunnerAccessRow): RunnerAccessIdentity {
  return {
    installationId: row.installation_id,
    prismUserId: row.prism_user_id,
    slackConnectionId: row.slack_connection_id,
    signingPublicKey: row.signing_public_key
  };
}

function safeHashEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
