import "server-only";

import { insertActivityAuditRecord } from "../audit/postgres-store";
import type { Database } from "../db";
import { hashSecret } from "../slack/oauth-flow";
import { issueApplicationProfileToken } from "../token-profiles/application-profile";
import { createPostgresGlobalTokenProfilePolicyStore } from "../token-profiles/global-policy-store";
import { validateRequestedTokenProfilePolicy } from "../token-profiles/global-policy";
import { buildTokenProfilePolicy } from "../token-profiles/presets";
import type { LocalAppAuthorizationStore } from "./types";

const RATE_WINDOW_MS = 60_000;
const MAX_PER_CLIENT_WINDOW = 30;
const MAX_PER_SOURCE_WINDOW = 30;
const MAX_GLOBAL_WINDOW = 300;
const MAX_CLIENT_OUTSTANDING = 20;
const MAX_GLOBAL_OUTSTANDING = 500;
const CLEANUP_BATCH_SIZE = 100;
const MAX_CONSENT_PER_SOURCE_WINDOW = 30;
const MAX_CONSENT_GLOBAL_WINDOW = 300;
const MAX_POLL_PER_SOURCE_WINDOW = 120;
const MAX_POLL_GLOBAL_WINDOW = 1_200;

type AuthorizationRow = {
  id: string;
  client_id: string;
  display_name: string;
  intended_use: string;
  status: "pending" | "approved" | "denied" | "exchanged" | "expired" | "policy_denied";
  poll_interval_seconds: number;
  last_polled_at: Date | null;
  approved_prism_user_id: string | null;
  approved_slack_connection_id: string | null;
  expires_at: Date;
};

export function createPostgresLocalAppAuthorizationStore(database: Database): LocalAppAuthorizationStore {
  return {
    async begin(input) {
      return database.transaction(async (tx) => {
        await tx.query(
          `delete from prism_local_app_authorizations
           where id in (
             select id from prism_local_app_authorizations
             where (terminal_at is not null and terminal_at < $1 - interval '1 day')
                or expires_at < $1 - interval '1 day'
             order by coalesce(terminal_at, expires_at)
             limit $2
           )`,
          [input.now, CLEANUP_BATCH_SIZE]
        );
        await cleanupRateLimits(tx, input.now);
        const allowed =
          (await consumeRateLimit(tx, "global", MAX_GLOBAL_WINDOW, input.now))
          && (await consumeRateLimit(tx, `client:${input.clientId}`, MAX_PER_CLIENT_WINDOW, input.now))
          && await consumeRateLimit(tx, `source:${input.sourceKey}`, MAX_PER_SOURCE_WINDOW, input.now);
        if (!allowed) return "rate_limited";

        const counts = await tx.query<{ global_count: string; client_count: string }>(
          `select
             count(*) filter (where status in ('pending', 'approved') and expires_at > $2) as global_count,
             count(*) filter (where client_id = $1 and status in ('pending', 'approved') and expires_at > $2) as client_count
           from prism_local_app_authorizations`,
          [input.clientId, input.now]
        );
        const count = counts.rows[0];
        if (!count
          || Number(count.global_count) >= MAX_GLOBAL_OUTSTANDING
          || Number(count.client_count) >= MAX_CLIENT_OUTSTANDING) {
          return "rate_limited";
        }

        await tx.query(
          `insert into prism_local_app_authorizations
             (id, device_code_hash, user_code_hash, client_id, display_name,
              intended_use, source_key, poll_interval_seconds, expires_at,
              created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
          [
            input.requestId, input.deviceCodeHash, input.userCodeHash, input.clientId,
            input.displayName, input.intendedUse, input.sourceKey,
            input.pollIntervalSeconds, input.expiresAt, input.now
          ]
        );
        return "created";
      });
    },

    async consumeRequestRateLimit(input) {
      return database.transaction(async (tx) => {
        await cleanupRateLimits(tx, input.now);
        const maximumGlobal = input.action === "consent" ? MAX_CONSENT_GLOBAL_WINDOW : MAX_POLL_GLOBAL_WINDOW;
        const maximumSource = input.action === "consent" ? MAX_CONSENT_PER_SOURCE_WINDOW : MAX_POLL_PER_SOURCE_WINDOW;
        return (await consumeRateLimit(tx, `${input.action}:global`, maximumGlobal, input.now))
          && await consumeRateLimit(tx, `${input.action}:source:${input.sourceKey}`, maximumSource, input.now);
      });
    },

    async resolveConsent(input) {
      const authorization = await database.query<{
        id: string;
        client_id: string;
        display_name: string;
        intended_use: string;
        expires_at: Date;
        status: AuthorizationRow["status"];
      }>(
        `select id, client_id, display_name, intended_use, expires_at, status
         from prism_local_app_authorizations
         where $1::text is not null
           and user_code_hash = $1
           and ($2::uuid is null or id = $2)
         limit 1`,
        [input.userCodeHash, input.requestId]
      );
      const request = authorization.rows[0];
      if (!request || request.status !== "pending") return { kind: "unavailable" };
      if (request.expires_at <= input.now) {
        await markExpired(database, request.id, input.now);
        return { kind: "expired" };
      }
      if (!input.sessionTokenHash) return { kind: "login_required", requestId: request.id };

      const session = await database.query<{
        prism_user_id: string;
        slack_connection_id: string;
        authed_user_id: string;
        authed_user_display_name: string | null;
        installation_scope: "workspace" | "organization";
        team_id: string | null;
        team_name: string | null;
        enterprise_id: string | null;
        enterprise_name: string | null;
        re_pairing: boolean;
      }>(
        `select s.prism_user_id, s.slack_connection_id,
                c.authed_user_id, c.authed_user_display_name,
                c.installation_scope, c.team_id, c.team_name,
                c.enterprise_id, c.enterprise_name,
                exists(
                  select 1 from token_profiles p
                  where p.prism_user_id = s.prism_user_id
                    and p.client_id = $3 and p.status = 'active'
                ) as re_pairing
         from prism_sessions s
         join slack_connections c
           on c.id = s.slack_connection_id and c.prism_user_id = s.prism_user_id
         where s.session_token_hash = $1 and s.expires_at > $2
           and c.status = 'healthy'
           and exists (
             select 1 from slack_credentials sc
             where sc.connection_id = c.id and sc.kind = 'user'
           )
         limit 1`,
        [input.sessionTokenHash, input.now, request.client_id]
      );
      const identity = session.rows[0];
      if (!identity) return { kind: "connection_unavailable", requestId: request.id };
      return {
        kind: "preview",
        preview: {
          requestId: request.id,
          clientId: request.client_id,
          displayName: request.display_name,
          intendedUse: request.intended_use,
          expiresAt: request.expires_at,
          rePairing: identity.re_pairing,
          identity: {
            prismUserId: identity.prism_user_id,
            slackConnectionId: identity.slack_connection_id,
            slackUserId: identity.authed_user_id,
            slackUserDisplayName: identity.authed_user_display_name,
            installationScope: identity.installation_scope,
            teamId: identity.team_id,
            teamName: identity.team_name,
            enterpriseId: identity.enterprise_id,
            enterpriseName: identity.enterprise_name
          }
        }
      };
    },

    async decide(input) {
      return database.transaction(async (tx) => {
        const request = await tx.query<AuthorizationRow>(
          `select id, client_id, display_name, intended_use, status,
                  poll_interval_seconds, last_polled_at,
                  approved_prism_user_id, approved_slack_connection_id, expires_at
           from prism_local_app_authorizations
           where id = $1
           for update`,
          [input.requestId]
        );
        const authorization = request.rows[0];
        if (!authorization || authorization.status !== "pending" || authorization.expires_at <= input.now) {
          if (authorization?.expires_at && authorization.expires_at <= input.now) {
            await markExpired(tx, input.requestId, input.now);
          }
          return "unavailable";
        }
        const session = await tx.query<{
          prism_user_id: string;
          slack_connection_id: string;
          authed_user_id: string;
          team_id: string | null;
          enterprise_id: string | null;
        }>(
          `select s.prism_user_id, s.slack_connection_id,
                  c.authed_user_id, c.team_id, c.enterprise_id
           from prism_sessions s
           join slack_connections c
             on c.id = s.slack_connection_id and c.prism_user_id = s.prism_user_id
           where s.session_token_hash = $1 and s.expires_at > $2
             and c.status = 'healthy'
             and exists (
               select 1 from slack_credentials sc
               where sc.connection_id = c.id and sc.kind = 'user'
             )
           limit 1
           for update of c`,
          [input.sessionTokenHash, input.now]
        );
        const identity = session.rows[0];
        if (!identity) return "connection_unavailable";

        const approved = input.decision === "approve";
        await tx.query(
          `update prism_local_app_authorizations
           set status = $2,
               approved_prism_user_id = case when $2 = 'approved' then $3 else null end,
               approved_slack_connection_id = case when $2 = 'approved' then $4 else null end,
               decided_at = $5,
               terminal_at = case when $2 = 'denied' then $5 else null end,
               updated_at = $5
           where id = $1 and status = 'pending'`,
          [input.requestId, approved ? "approved" : "denied", identity.prism_user_id, identity.slack_connection_id, input.now]
        );
        await insertActivityAuditRecord(tx, {
          prismUserId: identity.prism_user_id,
          slackConnectionId: identity.slack_connection_id,
          slackUserId: identity.authed_user_id,
          slackTeamId: identity.team_id,
          slackEnterpriseId: identity.enterprise_id,
          activityType: approved ? "local_app_authorization_approved" : "local_app_authorization_denied",
          endpoint: "/local-app/authorize",
          actionCategory: "local_app_authorization",
          objectType: "local_app_client",
          objectId: authorization.client_id,
          status: approved ? "approved" : "denied",
          httpStatus: 200,
          requestId: input.auditRequestId,
          upstreamCalled: false,
          occurredAt: input.now
        });
        return approved ? "approved" : "denied";
      });
    },

    async denyAfterOAuth(input) {
      await database.query(
        `update prism_local_app_authorizations
         set status = 'denied',
             decided_at = coalesce(decided_at, $2),
             terminal_at = coalesce(terminal_at, $2),
             updated_at = $2
         where id = $1 and status = 'pending'`,
        [input.requestId, input.now]
      );
    },

    async exchange(input) {
      return database.transaction(async (tx) => {
        const request = await tx.query<AuthorizationRow>(
          `select id, client_id, display_name, intended_use, status,
                  poll_interval_seconds, last_polled_at,
                  approved_prism_user_id, approved_slack_connection_id, expires_at
           from prism_local_app_authorizations
           where device_code_hash = $1 and client_id = $2
           for update`,
          [input.deviceCodeHash, input.clientId]
        );
        const authorization = request.rows[0];
        if (!authorization) return { kind: "invalid_grant" };
        if (authorization.status === "exchanged") return { kind: "invalid_grant" };
        if (authorization.status === "denied") return { kind: "denied" };
        if (authorization.status === "policy_denied") return { kind: "policy_denied" };
        if (authorization.expires_at <= input.now || authorization.status === "expired") {
          await markExpired(tx, authorization.id, input.now);
          return { kind: "expired" };
        }
        if (authorization.last_polled_at) {
          const nextPoll = authorization.last_polled_at.getTime() + authorization.poll_interval_seconds * 1000;
          if (nextPoll > input.now.getTime()) {
            return {
              kind: "slow_down",
              retryAfterSeconds: Math.max(1, Math.ceil((nextPoll - input.now.getTime()) / 1000))
            };
          }
        }
        await tx.query(
          `update prism_local_app_authorizations
           set last_polled_at = $2, updated_at = $2 where id = $1`,
          [authorization.id, input.now]
        );
        if (authorization.status === "pending") return { kind: "pending" };
        if (!authorization.approved_prism_user_id || !authorization.approved_slack_connection_id) {
          return { kind: "invalid_grant" };
        }

        const policy = buildTokenProfilePolicy(
          { preset: "messages_only", executionIdentity: "user" },
          input.now
        );
        const globalPolicy = await createPostgresGlobalTokenProfilePolicyStore(tx)
          .readGlobalTokenProfilePolicy();
        const policyDecision = validateRequestedTokenProfilePolicy({
          input: { preset: "messages_only", executionIdentity: "user" },
          capabilityMap: policy.capabilityMap,
          expiresAt: policy.expiresAt,
          policyEffectiveAt: input.now,
          policy: globalPolicy.policy
        });
        if (policyDecision.kind !== "allowed") {
          await tx.query(
            `update prism_local_app_authorizations
             set status = 'policy_denied', terminal_at = $2, updated_at = $2
             where id = $1`,
            [authorization.id, input.now]
          );
          return { kind: "policy_denied" };
        }

        const workspaceResult = await tx.query<{ team_id: string; team_name: string | null }>(
          `select c.team_id, c.team_name
           from slack_connections c
           where c.id = $1 and c.installation_scope = 'workspace' and c.team_id is not null
           union all
           select g.team_id, g.team_name
           from slack_connections c
           join slack_connection_workspace_grants g
             on g.slack_connection_id = c.id and g.status = 'active'
           where c.id = $1 and c.installation_scope = 'organization'
           order by team_name nulls last, team_id`,
          [authorization.approved_slack_connection_id]
        );
        if (workspaceResult.rows.length === 0) return { kind: "invalid_grant" };

        const credential = input.issueCredential();
        const issued = await issueApplicationProfileToken(tx, {
          prismUserId: authorization.approved_prism_user_id,
          slackConnectionId: authorization.approved_slack_connection_id,
          clientId: authorization.client_id,
          profileName: `Local application: ${authorization.client_id}`.slice(0, 120),
          intendedUse: "Read and send Slack messages for a paired local application.",
          preset: "messages_only",
          capabilityMap: policy.capabilityMap,
          expiresAt: policy.expiresAt,
          verifier: credential.verifier,
          rotation: "immediate",
          now: input.now
        });
        if (!issued) return { kind: "invalid_grant" };

        await tx.query(
          `update prism_local_app_authorizations
           set status = 'exchanged', token_profile_id = $2,
               exchanged_at = $3, terminal_at = $3, updated_at = $3
           where id = $1 and status = 'approved'`,
          [authorization.id, issued.profileId, input.now]
        );
        await insertActivityAuditRecord(tx, {
          prismUserId: authorization.approved_prism_user_id,
          slackConnectionId: authorization.approved_slack_connection_id,
          tokenProfileId: issued.profileId,
          tokenProfileName: issued.profileName,
          slackTeamId: issued.slackTeamId,
          slackEnterpriseId: issued.slackEnterpriseId,
          activityType: "local_app_token_issued",
          endpoint: "/v1/prism/local-app/authorizations/token",
          actionCategory: "messages_only",
          objectType: "local_app_client",
          objectId: authorization.client_id,
          status: "issued",
          httpStatus: 200,
          requestId: input.auditRequestId,
          upstreamCalled: false,
          occurredAt: input.now
        });
        return {
          kind: "issued",
          developerToken: credential.developerToken,
          tokenProfileId: issued.profileId,
          clientId: authorization.client_id,
          subject: {
            prismUserId: authorization.approved_prism_user_id,
            installationScope: issued.installationScope,
            slackTeamId: issued.slackTeamId,
            slackEnterpriseId: issued.slackEnterpriseId,
            workspaces: workspaceResult.rows.map((workspace) => ({
              teamId: workspace.team_id,
              teamName: workspace.team_name
            }))
          }
        };
      });
    }
  };
}

async function cleanupRateLimits(database: Database, now: Date): Promise<void> {
  await database.query(
    `delete from prism_local_app_authorization_rate_limits target
     using (
       select bucket_key from prism_local_app_authorization_rate_limits
       where window_reset_at < $1 - interval '1 day'
       order by window_reset_at
       limit $2
     ) stale
     where target.bucket_key = stale.bucket_key`,
    [now, CLEANUP_BATCH_SIZE]
  );
}

async function consumeRateLimit(
  database: Database,
  bucket: string,
  maximum: number,
  now: Date
): Promise<boolean> {
  const bucketKey = hashSecret(`local-app-authorization:${bucket}`);
  const resetAt = new Date(now.getTime() + RATE_WINDOW_MS);
  const result = await database.query<{ request_count: number }>(
    `insert into prism_local_app_authorization_rate_limits
       (bucket_key, window_started_at, window_reset_at, request_count, updated_at)
     values ($1, $2, $3, 1, $2)
     on conflict (bucket_key) do update set
       window_started_at = case
         when prism_local_app_authorization_rate_limits.window_reset_at <= $2 then $2
         else prism_local_app_authorization_rate_limits.window_started_at end,
       window_reset_at = case
         when prism_local_app_authorization_rate_limits.window_reset_at <= $2 then $3
         else prism_local_app_authorization_rate_limits.window_reset_at end,
       request_count = case
         when prism_local_app_authorization_rate_limits.window_reset_at <= $2 then 1
         else prism_local_app_authorization_rate_limits.request_count + 1 end,
       updated_at = $2
     returning request_count`,
    [bucketKey, now, resetAt]
  );
  return (result.rows[0]?.request_count ?? maximum + 1) <= maximum;
}

async function markExpired(database: Database, requestId: string, now: Date): Promise<void> {
  await database.query(
    `update prism_local_app_authorizations
     set status = 'expired', terminal_at = coalesce(terminal_at, $2), updated_at = $2
     where id = $1 and status in ('pending', 'approved')`,
    [requestId, now]
  );
}
