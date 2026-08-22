import "server-only";

import type { Database } from "../db";
import {
  SETUP_EXCHANGE_GLOBAL_CIRCUIT_BREAKER_MAX_ATTEMPTS,
  SETUP_EXCHANGE_RATE_LIMIT_MAX_ATTEMPTS_PER_SOURCE,
  SETUP_EXCHANGE_RATE_LIMIT_WINDOW_MS,
  SetupBootstrapRateLimitedError,
  SetupBootstrapRecoveryRequiredError,
  SetupBootstrapStoreUnavailableError,
  type SetupBootstrapCapabilityRecord,
  type SetupBootstrapStore,
  type SetupConfigurationAdminClaim,
  type SetupPurpose,
  type SetupSessionContext
} from "./bootstrap";

type BootstrapCapabilityRow = {
  id: string;
  purpose: SetupPurpose;
  recovery: boolean;
  created_at: Date;
  expires_at: Date;
};

type SetupClaimedRow = { setup_claimed: boolean };

type ConsumedCapabilityRow = {
  id: string;
  purpose: SetupPurpose;
  recovery: boolean;
};

type SetupSessionRow = {
  id: string;
  bootstrap_token_id: string;
  purpose: SetupPurpose;
  recovery: boolean;
  expires_at: Date;
  pending_configuration_version_id: string | null;
};

type SetupSessionClaimRow = {
  id: string;
  recovery: boolean;
  configuration_version_id: string;
};

type SetupRateLimitRow = {
  attempt_count: number;
  window_started_at: Date;
};

const BOOTSTRAP_ADVISORY_LOCK = "prism:setup-bootstrap";
const CONFIGURATION_ADMIN_ADVISORY_LOCK = "prism:configuration-admin-claim";
const GLOBAL_SETUP_EXCHANGE_BUCKET = "global:initial_slack_configuration";

export function createPostgresSetupBootstrapStore(database: Database): SetupBootstrapStore {
  return {
    async mintCapability(input) {
      return database.transaction(async (tx) => {
        await acquireAdvisoryLock(tx, BOOTSTRAP_ADVISORY_LOCK);
        const setupClaimed = await tx.query<SetupClaimedRow>(
          `select (
             exists (
               select 1 from prism_slack_app_configuration_versions
               where status = 'active'
             )
             or exists (
               select 1 from prism_configuration_admins
               where revoked_at is null
             )
           ) as setup_claimed`
        );
        if (setupClaimed.rows[0]?.setup_claimed && !input.recovery) {
          throw new SetupBootstrapRecoveryRequiredError();
        }

        if (input.recovery) {
          await tx.query(
            `update prism_setup_sessions
             set revoked_at = $1
             where revoked_at is null and claimed_at is null`,
            [input.createdAt]
          );
        }

        await tx.query(
          `update prism_setup_bootstrap_tokens
           set revoked_at = $1
           where used_at is null and revoked_at is null`,
          [input.createdAt]
        );

        const inserted = await tx.query<BootstrapCapabilityRow>(
          `insert into prism_setup_bootstrap_tokens
             (id, token_hash, purpose, recovery, created_at, expires_at)
           values ($1, $2, $3, $4, $5, $6)
           returning id, purpose, recovery, created_at, expires_at`,
          [input.id, input.tokenHash, input.purpose, input.recovery, input.createdAt, input.expiresAt]
        );
        const row = inserted.rows[0];
        if (!row) throw new SetupBootstrapStoreUnavailableError();
        return toCapabilityRecord(row);
      });
    },

    async consumeCapability(input) {
      if (
        input.sourceRateLimitBucketKey !== null &&
        !/^source:[0-9a-f]{64}$/.test(input.sourceRateLimitBucketKey)
      ) {
        throw new SetupBootstrapStoreUnavailableError();
      }
      const outcome = await database.transaction(async (tx) => {
        const globalRateLimit = await incrementExchangeRateLimit(
          tx,
          GLOBAL_SETUP_EXCHANGE_BUCKET,
          input.now
        );
        const sourceRateLimit = input.sourceRateLimitBucketKey
          ? await incrementExchangeRateLimit(tx, input.sourceRateLimitBucketKey, input.now)
          : null;
        if (
          globalRateLimit.attemptCount > SETUP_EXCHANGE_GLOBAL_CIRCUIT_BREAKER_MAX_ATTEMPTS ||
          (sourceRateLimit?.attemptCount ?? 0) > SETUP_EXCHANGE_RATE_LIMIT_MAX_ATTEMPTS_PER_SOURCE
        ) {
          const exceededWindows = [
            globalRateLimit.attemptCount > SETUP_EXCHANGE_GLOBAL_CIRCUIT_BREAKER_MAX_ATTEMPTS
              ? globalRateLimit.windowStartedAt
              : null,
            sourceRateLimit &&
            sourceRateLimit.attemptCount > SETUP_EXCHANGE_RATE_LIMIT_MAX_ATTEMPTS_PER_SOURCE
              ? sourceRateLimit.windowStartedAt
              : null
          ].filter((value): value is Date => value !== null);
          return {
            kind: "rate_limited" as const,
            retryAfterSeconds: Math.max(
              1,
              ...exceededWindows.map((windowStartedAt) =>
                Math.ceil(
                  (windowStartedAt.getTime() + SETUP_EXCHANGE_RATE_LIMIT_WINDOW_MS - input.now.getTime()) /
                    1000
                )
              )
            )
          };
        }

        const consumed = await tx.query<ConsumedCapabilityRow>(
          `update prism_setup_bootstrap_tokens
           set used_at = $2, used_by_request_id = $3
           where token_hash = $1
             and purpose = $4
             and used_at is null
             and revoked_at is null
             and expires_at > $2
           returning id, purpose, recovery`,
          [input.tokenHash, input.now, input.requestId, input.purpose]
        );
        const capability = consumed.rows[0];
        if (!capability) return { kind: "consumed" as const, session: null };

        const inserted = await tx.query<SetupSessionRow>(
          `insert into prism_setup_sessions
             (id, session_token_hash, bootstrap_token_id, purpose, created_at, expires_at)
           values ($1, $2, $3, $4, $5, $6)
           returning id, bootstrap_token_id, purpose, expires_at,
             $7::boolean as recovery,
             null::text as pending_configuration_version_id`,
          [
            input.setupSessionId,
            input.sessionTokenHash,
            capability.id,
            input.purpose,
            input.now,
            input.expiresAt,
            capability.recovery
          ]
        );
        const row = inserted.rows[0];
        if (!row) throw new SetupBootstrapStoreUnavailableError();
        return { kind: "consumed" as const, session: toSetupSessionContext(row) };
      });
      if (outcome.kind === "rate_limited") {
        throw new SetupBootstrapRateLimitedError(outcome.retryAfterSeconds);
      }
      return outcome.session;
    },

    async resolveSession({ sessionTokenHash, now }) {
      const result = await database.query<SetupSessionRow>(
        `select s.id, s.bootstrap_token_id, s.purpose, b.recovery, s.expires_at,
           (
             select c.id
             from prism_slack_app_configuration_versions c
             where c.setup_session_id = s.id and c.status = 'pending'
             order by c.version desc
             limit 1
           ) as pending_configuration_version_id
         from prism_setup_sessions s
         join prism_setup_bootstrap_tokens b on b.id = s.bootstrap_token_id
         where s.session_token_hash = $1
           and s.purpose = $2
           and s.revoked_at is null
           and s.claimed_at is null
           and s.expires_at > $3
         limit 1`,
        [sessionTokenHash, "initial_slack_configuration", now]
      );
      const row = result.rows[0];
      return row ? toSetupSessionContext(row) : null;
    },

    async claimSessionAndConfigurationAdmin(input) {
      return database.transaction(async (tx) => {
        await acquireAdvisoryLock(tx, CONFIGURATION_ADMIN_ADVISORY_LOCK);
        const locked = await tx.query<SetupSessionClaimRow>(
          `select s.id, b.recovery, c.id as configuration_version_id
           from prism_setup_sessions s
           join prism_setup_bootstrap_tokens b on b.id = s.bootstrap_token_id
           join prism_slack_app_configuration_versions c
             on c.id = $2 and c.setup_session_id = s.id
           where s.id = $1
             and s.revoked_at is null
             and s.claimed_at is null
             and s.expires_at > $3
             and c.status in ('pending', 'active')
           for update of s, c`,
          [input.setupSessionId, input.configurationVersionId, input.now]
        );
        const session = locked.rows[0];
        if (!session) return null;

        if (!session.recovery) {
          const existingAdmin = await tx.query<{ prism_user_id: string }>(
            `select prism_user_id
             from prism_configuration_admins
             where revoked_at is null
             for update`
          );
          if (existingAdmin.rows.length > 0) return null;
        }

        const claimed = await tx.query<{ id: string }>(
          `update prism_setup_sessions
           set claimed_at = $2, claimed_by_prism_user_id = $3
           where id = $1 and claimed_at is null and revoked_at is null
           returning id`,
          [input.setupSessionId, input.now, input.prismUserId]
        );
        if (!claimed.rows[0]) throw new SetupBootstrapStoreUnavailableError();

        if (session.recovery) {
          await tx.query(
            `update prism_configuration_admins
             set revoked_at = $1
             where revoked_at is null`,
            [input.now]
          );
        }

        await tx.query(
          `insert into prism_configuration_admins
             (prism_user_id, role, claim_source, created_at, revoked_at)
           values ($1, 'global_configuration_admin', 'initial_bootstrap', $2, null)
           on conflict (prism_user_id) do update
             set role = excluded.role,
                 claim_source = excluded.claim_source,
                 created_at = excluded.created_at,
                 revoked_at = null`,
          [input.prismUserId, input.now]
        );

        return { recovery: session.recovery } satisfies SetupConfigurationAdminClaim;
      });
    }
  };
}

async function incrementExchangeRateLimit(
  database: Database,
  bucketKey: string,
  now: Date
): Promise<{ attemptCount: number; windowStartedAt: Date }> {
  const result = await database.query<SetupRateLimitRow>(
    `insert into prism_setup_rate_limit_buckets
       (bucket_key, window_started_at, attempt_count, updated_at)
     values ($1, $2, 1, $2)
     on conflict (bucket_key) do update
       set attempt_count = case
             when $2 >= prism_setup_rate_limit_buckets.window_started_at
               + ($3::bigint * interval '1 millisecond') then 1
             else prism_setup_rate_limit_buckets.attempt_count + 1
           end,
           window_started_at = case
             when $2 >= prism_setup_rate_limit_buckets.window_started_at
               + ($3::bigint * interval '1 millisecond') then $2
             else prism_setup_rate_limit_buckets.window_started_at
           end,
           updated_at = $2
     returning attempt_count, window_started_at`,
    [bucketKey, now, SETUP_EXCHANGE_RATE_LIMIT_WINDOW_MS]
  );
  const row = result.rows[0];
  if (!row) throw new SetupBootstrapStoreUnavailableError();
  return { attemptCount: row.attempt_count, windowStartedAt: row.window_started_at };
}

function acquireAdvisoryLock(database: Database, key: string): Promise<unknown> {
  return database.query(`select pg_advisory_xact_lock(hashtext($1))`, [key]);
}

function toCapabilityRecord(row: BootstrapCapabilityRow): SetupBootstrapCapabilityRecord {
  return {
    id: row.id,
    purpose: row.purpose,
    recovery: row.recovery,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function toSetupSessionContext(row: SetupSessionRow): SetupSessionContext {
  return {
    id: row.id,
    bootstrapTokenId: row.bootstrap_token_id,
    purpose: row.purpose,
    recovery: row.recovery,
    expiresAt: row.expires_at,
    pendingConfigurationVersionId: row.pending_configuration_version_id
  };
}
