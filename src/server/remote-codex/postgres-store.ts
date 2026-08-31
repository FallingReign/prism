import "server-only";

import { randomUUID, timingSafeEqual } from "node:crypto";

import type { Database } from "../db";
import { hashSecret, type PairingRecord, type PairingStatus, type PairingStore } from "./pairing-service";

type PairingRow = {
  id: string;
  secret_hash: string;
  signing_public_key: string;
  encryption_public_key: string;
  machine_label: string;
  companion_version: string;
  verification_phrase: string;
  source_key: string;
  source_attributed: boolean;
  signing_key_fingerprint: string;
  status: string;
  expires_at: Date | string;
  approved_prism_user_id: string | null;
  approved_slack_connection_id: string | null;
  approved_team_id: string | null;
};

export function createPostgresPairingStore(
  database: Database,
  ids: { installationId?: () => string; credentialFamilyId?: () => string } = {}
): PairingStore {
  const installationId = ids.installationId ?? (() => `rc_install_${randomUUID()}`);
  const credentialFamilyId = ids.credentialFamilyId ?? (() => `rc_family_${randomUUID()}`);

  return {
    async savePairing(record) {
      await database.transaction(async (transaction) => {
        const now = new Date(record.expiresAt.getTime() - 10 * 60 * 1000);
        await transaction.query(
          `delete from remote_codex_pairing_create_limits
            where (bucket_kind, bucket_key) in (
              select bucket_kind, bucket_key from remote_codex_pairing_create_limits
               where window_reset_at < $1 order by window_reset_at limit 100
            )`,
          [now]
        );
        await consumePairingBucket(transaction, "global", hashSecret("remote-codex-pairing-global-v1"), 60, now);
        if (record.sourceAttributed) {
          await consumePairingBucket(transaction, "source", record.sourceKey, 10, now);
        }
        await consumePairingBucket(transaction, "signing_key", record.signingKeyFingerprint, 5, now);
        await transaction.query(
          `delete from remote_codex_pairing_requests where id in (
             select id from remote_codex_pairing_requests
              where expires_at < $1 or (consumed_at is not null and consumed_at < $2)
              order by expires_at limit 100
           )`,
          [now, new Date(now.getTime() - 24 * 60 * 60 * 1000)]
        );
        const active = await transaction.query<{
          global_count: string | number;
          source_count: string | number;
          signing_count: string | number;
        }>(
          `select count(*)::integer as global_count,
                  count(*) filter (where source_key = $2)::integer as source_count,
                  count(*) filter (where signing_key_fingerprint = $3)::integer as signing_count
             from remote_codex_pairing_requests
            where status in ('pending', 'approved') and expires_at > $1`,
          [now, record.sourceKey, record.signingKeyFingerprint]
        );
        const counts = active.rows[0];
        if (
          Number(counts?.global_count ?? 0) >= 1_000 ||
          (record.sourceAttributed && Number(counts?.source_count ?? 0) >= 20) ||
          Number(counts?.signing_count ?? 0) >= 5
        ) throw new Error("pairing-capacity");
        await transaction.query(
          `insert into remote_codex_pairing_requests
             (id, secret_hash, signing_public_key, encryption_public_key, machine_label,
              companion_version, verification_phrase, source_key, source_attributed,
              signing_key_fingerprint, status, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)`,
          [
            record.id, record.secretHash, record.signingPublicKey, record.encryptionPublicKey,
            record.machineLabel, record.companionVersion, record.verificationPhrase,
            record.sourceKey, record.sourceAttributed, record.signingKeyFingerprint, record.expiresAt
          ]
        );
      });
    },

    async getPairing({ pairingId, now }) {
      const result = await database.query<PairingRow>(`${pairingSelect()} where id = $1 and expires_at > $2`, [pairingId, now]);
      return result.rows[0] ? mapPairing(result.rows[0]) : null;
    },

    async approvePairing(input) {
      return database.transaction(async (transaction) => {
        const pairingResult = await transaction.query<PairingRow>(
          `${pairingSelect()} where id = $1 and expires_at > $2 for update`,
          [input.pairingId, input.now]
        );
        const pairing = pairingResult.rows[0];
        if (!pairing || pairing.status !== "pending") return { kind: "invalid" } as const;

        const sessionResult = await transaction.query<{ prism_user_id: string; slack_connection_id: string }>(
          `select s.prism_user_id, s.slack_connection_id
             from prism_sessions s
             join slack_connections c
               on c.id = s.slack_connection_id and c.prism_user_id = s.prism_user_id
             left join slack_connection_workspace_grants g
               on g.slack_connection_id = c.id and g.team_id = $3 and g.status = 'active'
            where s.session_token_hash = $1 and s.expires_at > $2 and c.status = 'healthy'
              and exists (
                select 1 from slack_credentials cred
                 where cred.connection_id = c.id and cred.kind = 'bot'
              )
              and string_to_array(c.bot_scopes, ',') @> array['chat:write', 'im:write']::text[]
              and (
                (c.installation_scope = 'workspace' and c.team_id = $3)
                or (c.installation_scope = 'organization' and g.team_id = $3)
              )`,
          [input.sessionTokenHash, input.now, input.targetTeamId]
        );
        const identity = sessionResult.rows[0];
        if (!identity) return { kind: "wrong_owner" } as const;

        const updated = await transaction.query(
          `update remote_codex_pairing_requests
              set status = 'approved', approved_prism_user_id = $2,
                  approved_slack_connection_id = $3, approved_team_id = $4,
                  approved_at = $5
            where id = $1 and status = 'pending'`,
          [input.pairingId, identity.prism_user_id, identity.slack_connection_id, input.targetTeamId, input.now]
        );
        if (updated.rowCount !== 1) return { kind: "invalid" } as const;
        return { kind: "approved", machineLabel: pairing.machine_label, slackConnectionId: identity.slack_connection_id } as const;
      });
    },

    async recordFailedExchange({ pairingId, now }) {
      await database.query(
        `update remote_codex_pairing_requests
            set attempt_count = attempt_count + 1,
                status = case when attempt_count + 1 >= 20 then 'expired' else status end
          where id = $1 and status = 'approved' and expires_at > $2 and attempt_count < 20`,
        [pairingId, now]
      );
    },

    async completeExchange(input) {
      return database.transaction(async (transaction) => {
        const pairingResult = await transaction.query<PairingRow>(`${pairingSelect()} where id = $1 for update`, [input.pairingId]);
        const pairing = pairingResult.rows[0];
        if (
          !pairing ||
          pairing.status !== "approved" ||
          new Date(pairing.expires_at).getTime() <= input.now.getTime() ||
          !pairing.approved_prism_user_id ||
          !pairing.approved_slack_connection_id ||
          !pairing.approved_team_id ||
          !safeEqual(pairing.secret_hash, input.secretHash)
        ) {
          return null;
        }

        const consumed = await transaction.query(
          `update remote_codex_pairing_requests
              set status = 'consumed', consumed_at = $3
            where id = $1 and secret_hash = $2 and status = 'approved'`,
          [input.pairingId, input.secretHash, input.now]
        );
        if (consumed.rowCount !== 1) return null;

        const newInstallationId = installationId();
        await transaction.query(
          `insert into remote_codex_installations
             (id, prism_user_id, slack_connection_id, signing_public_key, encryption_public_key,
              default_team_id, machine_label, companion_version, state, paired_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'offline', $9)`,
          [
            newInstallationId,
            pairing.approved_prism_user_id,
            pairing.approved_slack_connection_id,
            pairing.signing_public_key,
            pairing.encryption_public_key,
            pairing.approved_team_id,
            pairing.machine_label,
            pairing.companion_version,
            input.now
          ]
        );
        await transaction.query(
          `insert into remote_codex_installation_credentials
             (installation_id, access_token_hash, access_token_expires_at, refresh_token_hash,
              refresh_family_id, refresh_rotation, refresh_token_expires_at)
           values ($1, $2, $3, $4, $5, 0, $6)`,
          [
            newInstallationId,
            input.accessTokenHash,
            input.accessTokenExpiresAt,
            input.refreshTokenHash,
            credentialFamilyId(),
            input.refreshTokenExpiresAt
          ]
        );
        return { installationId: newInstallationId };
      });
    }
  };
}

function pairingSelect(): string {
  return `select id, secret_hash, signing_public_key, encryption_public_key, machine_label,
                 companion_version, verification_phrase, source_key, source_attributed,
                 signing_key_fingerprint,
                 status, expires_at, approved_prism_user_id, approved_slack_connection_id,
                 approved_team_id
            from remote_codex_pairing_requests`;
}

function mapPairing(row: PairingRow): PairingRecord {
  return {
    id: row.id,
    secretHash: row.secret_hash,
    signingPublicKey: row.signing_public_key,
    encryptionPublicKey: row.encryption_public_key,
    machineLabel: row.machine_label,
    companionVersion: row.companion_version,
    verificationPhrase: row.verification_phrase,
    sourceKey: row.source_key,
    sourceAttributed: row.source_attributed,
    signingKeyFingerprint: row.signing_key_fingerprint,
    status: pairingStatus(row.status),
    expiresAt: new Date(row.expires_at),
    approvedPrismUserId: row.approved_prism_user_id,
    approvedSlackConnectionId: row.approved_slack_connection_id,
    approvedTeamId: row.approved_team_id
  };
}

async function consumePairingBucket(
  database: Database,
  bucketKind: "global" | "source" | "signing_key",
  bucketKey: string,
  maximum: number,
  now: Date
): Promise<void> {
  const resetAt = new Date(now.getTime() + 60_000);
  const result = await database.query<{ request_count: string | number }>(
    `insert into remote_codex_pairing_create_limits
       (bucket_kind, bucket_key, window_started_at, window_reset_at, request_count, updated_at)
     values ($1, $2, $3, $4, 1, $3)
     on conflict (bucket_kind, bucket_key) do update
       set window_started_at = case
             when remote_codex_pairing_create_limits.window_reset_at <= excluded.window_started_at
             then excluded.window_started_at else remote_codex_pairing_create_limits.window_started_at end,
           window_reset_at = case
             when remote_codex_pairing_create_limits.window_reset_at <= excluded.window_started_at
             then excluded.window_reset_at else remote_codex_pairing_create_limits.window_reset_at end,
           request_count = case
             when remote_codex_pairing_create_limits.window_reset_at <= excluded.window_started_at
             then 1 else remote_codex_pairing_create_limits.request_count + 1 end,
           updated_at = excluded.updated_at
     returning request_count`,
    [bucketKind, bucketKey, now, resetAt]
  );
  if (Number(result.rows[0]?.request_count ?? maximum + 1) > maximum) {
    throw new Error("pairing-rate-limit");
  }
}

function pairingStatus(value: string): PairingStatus {
  if (value === "pending" || value === "approved" || value === "consumed" || value === "expired") return value;
  return "expired";
}

function safeEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
