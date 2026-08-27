import "server-only";

import type { CredentialEnvelope } from "../credentials/encryption";
import type { Database } from "../db";
import { insertActivityAuditRecord } from "../audit/postgres-store";
import { hashSecret } from "../slack/oauth-flow";
import type {
  DelegatedApprovalResult,
  DelegatedConsentLookup,
  DelegatedDeliveryStore,
  DelegatedGrantExecutionBinding,
  DelegatedGrantExchangeResult,
  DelegatedStoreLimits,
  StoredDelegationRequestResult
} from "./store";
import {
  DelegatedDeliveryStoreError,
  type DelegatedConsentIdentity,
  type DelegationRequestRecord
} from "./types";

export type DelegatedDeliveryCleanupResult = {
  expiredPendingRequests: number;
  expiredApprovedRequests: number;
  expiredGrants: number;
  deletedAuthorizationCodes: number;
  deletedDpopReplays: number;
  deletedRateBuckets: number;
  deletedSlackOAuthStates: number;
  deletedTerminalGrants: number;
  deletedTerminalRequests: number;
};

export async function runPostgresDelegatedDeliveryCleanup(input: {
  database: Database;
  now?: Date;
  statusRetentionMs: number;
  batchSize: number;
}): Promise<DelegatedDeliveryCleanupResult> {
  const now = input.now ?? new Date();
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(input.statusRetentionMs) ||
    input.statusRetentionMs < 1 ||
    input.statusRetentionMs > 30 * 24 * 60 * 60_000 ||
    !Number.isSafeInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > 1000
  ) {
    throw new Error("invalid-delegated-delivery-cleanup-limits");
  }
  return input.database.transaction((transaction) =>
    cleanupExpiredArtifacts(
      transaction,
      now,
      input.statusRetentionMs,
      input.batchSize
    )
  );
}

export function createPostgresDelegatedDeliveryStore(database: Database): DelegatedDeliveryStore {
  return {
    async createRequest(input): Promise<StoredDelegationRequestResult> {
      return database.transaction(async (tx) => {
        await cleanupExpiredArtifacts(
          tx,
          input.now,
          input.limits.statusRetentionMs,
          input.limits.cleanupBatchSize
        );
        await insertProofReplay(tx, input.proofReplay.jkt, input.proofReplay.jtiHash, input.proofReplay.expiresAt, input.now);
        const sourceKey = sourceBucketKey(input.request.clientId, input.sourceIdentifier);
        const enforceSourceLimits = input.sourceIdentifier !== "unattributed";
        await consumeRequestRateLimits(tx, {
          clientId: input.request.clientId,
          sourceKey,
          expectedPrismUserId: input.request.expectedPrismUserId,
          channelId: input.request.channelId,
          now: input.now,
          limits: input.limits,
          enforceSourceLimits
        });

        const lockKeys = [
          clientBucketKey(input.request.clientId),
          ...(enforceSourceLimits ? [sourceKey] : []),
          userBucketKey(input.request.clientId, input.request.expectedPrismUserId)
        ];
        for (const key of lockKeys) {
          await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        }

        const existing = await tx.query<RequestRow & { approval_handle_envelope: CredentialEnvelope | null; immutable_digest: string }>(
          `${REQUEST_SELECT}
             , approval_handle_envelope, immutable_digest
           from slack_delivery_delegation_requests
           where client_id = $1 and idempotency_key = $2
           for update`,
          [input.request.clientId, input.request.idempotencyKey]
        );
        const previous = existing.rows[0];
        if (previous) {
          if (previous.immutable_digest !== input.request.immutableDigest) {
            throw new DelegatedDeliveryStoreError("idempotency_conflict");
          }
          if (previous.state !== "pending") throw new DelegatedDeliveryStoreError("lifecycle_conflict");
          const previousRecord = toRequestRecord(previous);
          if (previousRecord.approvalExpiresAt <= input.now) throw new DelegatedDeliveryStoreError("expired");
          if (!previous.approval_handle_envelope) throw new DelegatedDeliveryStoreError("lifecycle_conflict");
          return { kind: "existing", request: previousRecord, approvalHandleEnvelope: previous.approval_handle_envelope };
        }

        const outstanding = await tx.query<OutstandingRow>(
          `select
             count(*) filter (where client_id = $1)::integer as client_count,
             count(*) filter (where client_id = $1 and source_key = $2)::integer as source_count,
             count(*) filter (where client_id = $1 and expected_prism_user_id = $3)::integer as user_count,
             min(approval_expires_at) filter (where client_id = $1) as client_retry_at,
             min(approval_expires_at) filter (where client_id = $1 and source_key = $2) as source_retry_at,
             min(approval_expires_at) filter (where client_id = $1 and expected_prism_user_id = $3) as user_retry_at
           from slack_delivery_delegation_requests
           where state = 'pending' and approval_expires_at > $4`,
          [input.request.clientId, sourceKey, input.request.expectedPrismUserId, input.now]
        );
        enforceOutstandingCaps(outstanding.rows[0], input.now, input.limits, enforceSourceLimits);

        const inserted = await tx.query<RequestRow>(
          `insert into slack_delivery_delegation_requests
             (id, approval_handle_hash, approval_handle_envelope, source_key,
              client_id, external_job_id, revision, idempotency_key, callback_uri,
              expected_prism_user_id, action, execution_mode, team_id, channel_id,
              payload_envelope, payload_sha256, return_state_envelope, code_challenge,
              dpop_jkt, not_before, approval_expires_at, delivery_expires_at,
              immutable_digest, state)
           values
             ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12,
              $13, $14, $15::jsonb, $16, $17::jsonb, $18, $19, $20, $21, $22,
              $23, 'pending')
           returning ${REQUEST_COLUMNS}`,
          [
            input.requestId,
            input.approvalHandleHash,
            JSON.stringify(input.approvalHandleEnvelope),
            sourceKey,
            input.request.clientId,
            input.request.externalJobId,
            input.request.revision,
            input.request.idempotencyKey,
            input.request.callbackUri,
            input.request.expectedPrismUserId,
            input.request.action,
            input.request.executionMode,
            input.request.teamId,
            input.request.channelId,
            JSON.stringify(input.payloadEnvelope),
            input.request.payloadSha256,
            JSON.stringify(input.returnStateEnvelope),
            input.request.codeChallenge,
            input.request.dpopJkt,
            input.request.notBefore,
            input.approvalExpiresAt,
            input.request.deliveryExpiresAt,
            input.request.immutableDigest
          ]
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("delegated-request-insert-unavailable");
        await insertActivityAuditRecord(tx, {
          activityType: "delegated_delivery_requested",
          endpoint: "/v1/prism/delegations/slack-message/requests",
          slackMethod: "chat.postMessage",
          actionCategory: "messages.write",
          surface: surfaceForChannel(input.request.channelId),
          objectType: "channel",
          objectId: input.request.channelId,
          executionMode: "user",
          status: "created",
          requestId: input.requestId,
          upstreamCalled: false
        });
        return { kind: "created", request: toRequestRecord(row), approvalHandleEnvelope: input.approvalHandleEnvelope };
      });
    },

    async loadConsent(input): Promise<DelegatedConsentLookup> {
      return database.transaction(async (tx) => {
        const result = await tx.query<RequestRow>(
          `${REQUEST_SELECT}
           from slack_delivery_delegation_requests
           where approval_handle_hash = $1 or oauth_resume_handle_hash = $1
           limit 1`,
          [input.handleHash]
        );
        const row = result.rows[0];
        if (!row) return { kind: "not_found" };
        if (row.state !== "pending") return { kind: row.state === "expired" ? "expired" : "not_found", requestId: row.id };
        const request = toRequestRecord(row);
        if (request.approvalExpiresAt <= input.now) {
          await expireRequest(tx, request, input.now);
          return { kind: "expired", requestId: request.id };
        }
        if (!input.sessionTokenHash) return { kind: "login_required", requestId: request.id };
        const session = await tx.query<{ prism_user_id: string }>(
          `select prism_user_id from prism_sessions
           where session_token_hash = $1 and expires_at > $2`,
          [input.sessionTokenHash, input.now]
        );
        if (!session.rows[0]) return { kind: "login_required", requestId: request.id };
        if (session.rows[0].prism_user_id !== request.expectedPrismUserId) {
          return { kind: "policy_denied", requestId: request.id };
        }
        const identity = await resolveEligibleIdentity(tx, request, input.sessionTokenHash, input.now, false);
        return identity
          ? { kind: "ready", request, identity }
          : { kind: "policy_denied", requestId: request.id };
      });
    },

    async saveOAuthResumeHandle({ requestId, handleHash, now }): Promise<boolean> {
      const result = await database.query(
        `update slack_delivery_delegation_requests
         set oauth_resume_handle_hash = $2, updated_at = $3
         where id = $1 and state = 'pending' and approval_expires_at > $3`,
        [requestId, handleHash, now]
      );
      return result.rowCount === 1;
    },

    async approveRequest(input): Promise<DelegatedApprovalResult | null> {
      return database.transaction(async (tx) => {
        const request = await lockAvailableRequest(tx, input.requestId, input.now);
        const identity = await resolveEligibleIdentity(tx, request, input.sessionTokenHash, input.now, true);
        if (!identity) throw new DelegatedDeliveryStoreError("policy_denied");
        await tx.query(
          `update slack_delivery_delegation_requests
           set state = 'approved', approved_slack_connection_id = $2,
               approved_connection_id_snapshot = $2, approved_prism_user_id = $3,
               approved_slack_user_id = $4, approved_slack_team_id = $5,
               approved_at = $6, approval_handle_envelope = null,
               return_state_envelope = null, oauth_resume_handle_hash = null,
               updated_at = $6
           where id = $1`,
          [request.id, identity.slackConnectionId, identity.prismUserId, identity.slackUserId, identity.teamId, input.now]
        );
        await tx.query(
          `insert into slack_delivery_authorization_codes
             (code_hash, request_id, expires_at)
           values ($1, $2, $3)`,
          [input.codeHash, request.id, input.codeExpiresAt]
        );
        await insertActivityAuditRecord(tx, auditForRequest(request, identity, "delegated_delivery_approved", "approved", input.now));
        return { request: { ...request, state: "approved" }, identity };
      });
    },

    async denyRequest(input): Promise<DelegationRequestRecord | null> {
      return database.transaction(async (tx) => {
        const request = await lockAvailableRequest(tx, input.requestId, input.now);
        if (!input.sessionTokenHash) throw new DelegatedDeliveryStoreError("policy_denied");
        const session = await tx.query<{ prism_user_id: string }>(
          `select prism_user_id from prism_sessions
           where session_token_hash = $1 and expires_at > $2
           for update`,
          [input.sessionTokenHash, input.now]
        );
        if (session.rows[0]?.prism_user_id !== request.expectedPrismUserId) {
          throw new DelegatedDeliveryStoreError("policy_denied");
        }
        await markDenied(tx, request, input.now, session.rows[0].prism_user_id);
        return request;
      });
    },

    async denyRequestAfterOAuth({ requestId, now }): Promise<DelegationRequestRecord | null> {
      return database.transaction(async (tx) => {
        const request = await lockAvailableRequest(tx, requestId, now);
        await markDenied(tx, request, now, null);
        return request;
      });
    },

    async loadCodeBinding({ codeHash, clientId, redirectUri, now }) {
      const result = await database.query<{
        dpop_jkt: string;
        used_at: Date | string | null;
        code_expires_at: Date | string;
        request_state: DelegationRequestRecord["state"];
        delivery_expires_at: Date | string;
      }>(
        `select r.dpop_jkt, c.used_at, c.expires_at as code_expires_at,
                r.state as request_state, r.delivery_expires_at
         from slack_delivery_authorization_codes c
         join slack_delivery_delegation_requests r on r.id = c.request_id
         where c.code_hash = $1 and r.client_id = $2 and r.callback_uri = $3`,
        [codeHash, clientId, redirectUri]
      );
      const row = result.rows[0];
      if (!row) return null;
      if (
        row.used_at !== null ||
        toDate(row.code_expires_at) <= now ||
        row.request_state !== "approved" ||
        toDate(row.delivery_expires_at) <= now
      ) {
        return { kind: "expired" };
      }
      return { kind: "ready", dpopJkt: row.dpop_jkt };
    },

    async exchangeCodeForGrant(input): Promise<DelegatedGrantExchangeResult | null> {
      return database.transaction(async (tx) => {
        await insertProofReplay(tx, input.proofReplay.jkt, input.proofReplay.jtiHash, input.proofReplay.expiresAt, input.now);
        const result = await tx.query<GrantBindingRow>(
          `select r.id as request_id, r.client_id, r.external_job_id, r.revision,
                  r.approved_prism_user_id as prism_user_id,
                  r.approved_slack_user_id as slack_user_id,
                  r.approved_slack_team_id as team_id,
                  r.channel_id, r.payload_sha256, r.not_before,
                  r.delivery_expires_at as expires_at,
                  r.approved_slack_connection_id as slack_connection_id,
                  r.approved_connection_id_snapshot as connection_id_snapshot,
                  c.code_hash, cred.scopes as user_scopes
           from slack_delivery_authorization_codes c
           join slack_delivery_delegation_requests r on r.id = c.request_id
           join slack_connections sc on sc.id = r.approved_slack_connection_id
                                    and sc.prism_user_id = r.approved_prism_user_id
                                    and sc.team_id = r.approved_slack_team_id
                                    and sc.authed_user_id = r.approved_slack_user_id
           join slack_credentials cred on cred.connection_id = sc.id and cred.kind = 'user'
           where c.code_hash = $1 and c.used_at is null and c.expires_at > $5
             and r.client_id = $2 and r.callback_uri = $3 and r.code_challenge = $4
             and r.state = 'approved' and r.delivery_expires_at > $5
             and sc.status = 'healthy'
           for update of c, r, sc, cred`,
          [input.codeHash, input.clientId, input.redirectUri, input.codeChallenge, input.now]
        );
        const row = result.rows.find((candidate) => candidate.prism_user_id && candidate.slack_user_id && candidate.team_id && hasChatWrite(candidate.user_scopes));
        if (!row) {
          const lifecycle = await tx.query<{
            used_at: Date | string | null;
            code_expires_at: Date | string;
            request_state: DelegationRequestRecord["state"];
            delivery_expires_at: Date | string;
          }>(
            `select c.used_at, c.expires_at as code_expires_at,
                    r.state as request_state, r.delivery_expires_at
             from slack_delivery_authorization_codes c
             join slack_delivery_delegation_requests r on r.id = c.request_id
             where c.code_hash = $1 and r.client_id = $2 and r.callback_uri = $3
               and r.code_challenge = $4`,
            [input.codeHash, input.clientId, input.redirectUri, input.codeChallenge]
          );
          const state = lifecycle.rows[0];
          if (!state) return null;
          if (
            state.used_at !== null ||
            toDate(state.code_expires_at) <= input.now ||
            state.request_state !== "approved" ||
            toDate(state.delivery_expires_at) <= input.now
          ) {
            throw new DelegatedDeliveryStoreError("expired");
          }
          throw new DelegatedDeliveryStoreError("policy_denied");
        }
        await tx.query("update slack_delivery_authorization_codes set used_at = $2 where code_hash = $1", [input.codeHash, input.now]);
        await tx.query(
          `insert into slack_delivery_grants
             (id, grant_hash, pepper_id, request_id, dpop_jkt, slack_connection_id,
              connection_id_snapshot, prism_user_id, slack_user_id, team_id,
              channel_id, state, attempt_count, upstream_called, expires_at,
              status_retained_until)
           values
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
              'active', 0, false, $12, $13)`,
          [
            input.grantId,
            input.grantHash,
            input.pepperId,
            row.request_id,
            input.proofReplay.jkt,
            row.slack_connection_id,
            row.connection_id_snapshot,
            row.prism_user_id,
            row.slack_user_id,
            row.team_id,
            row.channel_id,
            row.expires_at,
            new Date(toDate(row.expires_at).getTime() + input.statusRetentionMs)
          ]
        );
        const identity = identityFromGrantRow(row);
        await insertActivityAuditRecord(tx, auditForRequest(
          { id: row.request_id, channelId: row.channel_id },
          identity,
          "delegated_delivery_grant_issued",
          "issued",
          input.now
        ));
        return toGrantExchangeResult(input.grantId, row);
      });
    },

    async loadGrantExecutionBinding({ grantHash, pepperId }) {
      const result = await database.query<ExecutionRow>(executionSelect(false), [grantHash, pepperId]);
      return result.rows[0] ? toExecutionBinding(result.rows[0]) : null;
    },

    async claimGrantExecution(input) {
      return database.transaction(async (tx) => {
        await insertProofReplay(tx, input.proofReplay.jkt, input.proofReplay.jtiHash, input.proofReplay.expiresAt, input.now);
        const result = await tx.query<ExecutionRow>(executionSelect(true), [input.grantHash, input.pepperId]);
        const row = result.rows[0];
        if (!row) throw new DelegatedDeliveryStoreError("not_found");
        let binding = toExecutionBinding(row);
        if (binding.expiresAt <= input.now) {
          // Cleanup owns the durable expired transition. Throwing from this
          // transaction deliberately avoids pretending an update survived rollback.
          throw new DelegatedDeliveryStoreError("expired");
        }
        if (binding.state === "sent" || binding.state === "failed" || binding.state === "outcome_unknown") return binding;
        if (binding.state === "cancelled" || binding.state === "expired") throw new DelegatedDeliveryStoreError("expired");
        if (binding.state === "executing") {
          if (row.lease_expires_at && toDate(row.lease_expires_at) <= input.now) {
            const updated = await tx.query(
              `update slack_delivery_grants
               set state = 'outcome_unknown', lease_id = null, lease_expires_at = null,
                   last_error_code = 'execution_lease_expired', terminal_at = $2, updated_at = $2
               where id = $1`,
              [binding.grantId, input.now]
            );
            if (updated.rowCount !== 1) throw new DelegatedDeliveryStoreError("lifecycle_conflict");
            const refreshed = await tx.query<ExecutionRow>(executionSelect(false), [input.grantHash, input.pepperId]);
            binding = toExecutionBinding(refreshed.rows[0]!);
            await auditGrantExecution(tx, binding, "outcome_unknown", "execution_lease_expired", null, true, input.now);
            return binding;
          }
          throw new DelegatedDeliveryStoreError("lifecycle_conflict");
        }
        if (binding.notBefore > input.now) throw new DelegatedDeliveryStoreError("not_yet_valid");
        if (row.connection_status !== "healthy" || !hasChatWrite(row.user_scopes)) {
          throw new DelegatedDeliveryStoreError("policy_denied");
        }
        const claimed = await tx.query(
          `update slack_delivery_grants
           set state = 'executing', attempt_count = attempt_count + 1,
               lease_id = $2, lease_expires_at = $3, upstream_called = false,
               last_error_code = null, updated_at = $4
           where id = $1 and state = 'active'`,
          [binding.grantId, input.leaseId, input.leaseExpiresAt, input.now]
        );
        if (claimed.rowCount !== 1) throw new DelegatedDeliveryStoreError("lifecycle_conflict");
        const refreshed = await tx.query<ExecutionRow>(executionSelect(false), [input.grantHash, input.pepperId]);
        return toExecutionBinding(refreshed.rows[0]!);
      });
    },

    async finishGrantExecution(input) {
      return database.transaction(async (tx) => {
        const terminal = await tx.query(
          `update slack_delivery_grants
           set state = $3, lease_id = null, lease_expires_at = null,
               slack_request_id = $4, slack_ts = $5, last_error_code = $6,
               upstream_called = $7, executed_at = $8, terminal_at = $8, updated_at = $8
           where id = $1 and state = 'executing' and lease_id = $2`,
          [
            input.grantId, input.leaseId, input.state,
            input.slackRequestId ?? null, input.slackTs ?? null,
            input.errorCode ?? null, input.upstreamCalled, input.now
          ]
        );
        if (terminal.rowCount !== 1) throw new DelegatedDeliveryStoreError("lifecycle_conflict");
        const refreshed = await tx.query<ExecutionRow>(
          `select ${EXECUTION_COLUMNS}
           from slack_delivery_grants g
           join slack_delivery_delegation_requests r on r.id = g.request_id
           left join slack_connections sc on sc.id = g.slack_connection_id
           left join slack_credentials cred on cred.connection_id = sc.id and cred.kind = 'user'
           where g.id = $1`,
          [input.grantId]
        );
        const binding = toExecutionBinding(refreshed.rows[0]!);
        await auditGrantExecution(tx, binding, input.state, input.errorCode ?? null, input.httpStatus ?? null, input.upstreamCalled, input.now);
        return binding;
      });
    },

    async markGrantUpstreamCalled(input) {
      const updated = await database.query(
        `update slack_delivery_grants set upstream_called = true, updated_at = $3
         where id = $1 and state = 'executing' and lease_id = $2`,
        [input.grantId, input.leaseId, input.now]
      );
      if (updated.rowCount !== 1) throw new DelegatedDeliveryStoreError("lifecycle_conflict");
    }
  };
}

const EXECUTION_COLUMNS = `g.id as grant_id, g.request_id, r.external_job_id, r.revision,
  g.dpop_jkt, g.prism_user_id, g.slack_connection_id, g.connection_id_snapshot,
  g.slack_user_id, g.team_id, g.channel_id, r.payload_envelope, r.payload_sha256,
  r.not_before, g.expires_at, g.state, g.slack_ts, g.last_error_code,
  g.lease_expires_at, sc.status as connection_status, cred.scopes as user_scopes`;

function executionSelect(lock: boolean): string {
  return `select ${EXECUTION_COLUMNS}
    from slack_delivery_grants g
    join slack_delivery_delegation_requests r on r.id = g.request_id
    left join slack_connections sc on sc.id = g.slack_connection_id
      and sc.prism_user_id = g.prism_user_id and sc.authed_user_id = g.slack_user_id
      and sc.team_id = g.team_id
    left join slack_credentials cred on cred.connection_id = sc.id and cred.kind = 'user'
    where g.grant_hash = $1 and g.pepper_id = $2${lock ? " for update of g, r" : ""}`;
}

function toExecutionBinding(row: ExecutionRow): DelegatedGrantExecutionBinding {
  if (!row.payload_envelope) throw new DelegatedDeliveryStoreError("lifecycle_conflict");
  return {
    grantId: row.grant_id, requestId: row.request_id, externalJobId: row.external_job_id,
    revision: Number(row.revision), dpopJkt: row.dpop_jkt, prismUserId: row.prism_user_id,
    slackConnectionId: row.slack_connection_id, connectionIdSnapshot: row.connection_id_snapshot,
    slackUserId: row.slack_user_id, teamId: row.team_id, channelId: row.channel_id,
    payloadEnvelope: row.payload_envelope, payloadSha256: row.payload_sha256,
    notBefore: toDate(row.not_before), expiresAt: toDate(row.expires_at), state: row.state,
    slackTs: row.slack_ts, lastErrorCode: row.last_error_code
  };
}

async function auditGrantExecution(
  database: Database,
  binding: DelegatedGrantExecutionBinding,
  status: "sent" | "failed" | "outcome_unknown",
  errorClass: string | null,
  httpStatus: number | null,
  upstreamCalled: boolean,
  now: Date
): Promise<void> {
  await insertActivityAuditRecord(database, {
    prismUserId: binding.prismUserId, slackConnectionId: binding.slackConnectionId,
    slackUserId: binding.slackUserId, slackTeamId: binding.teamId,
    activityType: status === "outcome_unknown" ? "delegated_delivery_outcome_unknown" : "delegated_delivery_execution",
    endpoint: "/v1/prism/delegations/slack-message/execute", slackMethod: "chat.postMessage",
    actionCategory: "messages.write", surface: surfaceForChannel(binding.channelId),
    objectType: "channel", objectId: binding.channelId, executionMode: "user", status,
    errorClass, httpStatus, requestId: binding.requestId, upstreamCalled, occurredAt: now
  });
}

const REQUEST_COLUMNS = `id, client_id, external_job_id, revision, idempotency_key,
  callback_uri, expected_prism_user_id, action, execution_mode, team_id, channel_id,
  payload_envelope, payload_sha256, return_state_envelope, code_challenge, dpop_jkt,
  not_before, approval_expires_at, delivery_expires_at, state`;
const REQUEST_SELECT = `select ${REQUEST_COLUMNS}`;

async function lockAvailableRequest(database: Database, requestId: string, now: Date): Promise<DelegationRequestRecord> {
  const result = await database.query<RequestRow>(
    `${REQUEST_SELECT} from slack_delivery_delegation_requests where id = $1 for update`,
    [requestId]
  );
  const row = result.rows[0];
  if (!row) throw new DelegatedDeliveryStoreError("not_found");
  const request = toRequestRecord(row);
  if (request.state !== "pending") throw new DelegatedDeliveryStoreError("lifecycle_conflict");
  if (request.approvalExpiresAt <= now) {
    await expireRequest(database, request, now);
    throw new DelegatedDeliveryStoreError("expired");
  }
  return request;
}

async function resolveEligibleIdentity(
  database: Database,
  request: DelegationRequestRecord,
  sessionTokenHash: string | null,
  now: Date,
  lock: boolean
): Promise<DelegatedConsentIdentity | null> {
  if (!sessionTokenHash) return null;
  const result = await database.query<IdentityRow>(
    `select s.prism_user_id, c.id as slack_connection_id, c.authed_user_id as slack_user_id,
            nullif(c.authed_user_display_name, '') as slack_user_display_name,
            c.team_id, nullif(c.team_name, '') as team_name, cred.scopes as user_scopes
     from prism_sessions s
     join slack_connections c on c.prism_user_id = s.prism_user_id
     join slack_credentials cred on cred.connection_id = c.id and cred.kind = 'user'
     where s.session_token_hash = $1 and s.expires_at > $2
       and s.prism_user_id = $3 and c.team_id = $4 and c.status = 'healthy'
     order by c.updated_at desc
     limit 1${lock ? " for update of s, c, cred" : ""}`,
    [sessionTokenHash, now, request.expectedPrismUserId, request.teamId]
  );
  const row = result.rows.find((candidate) => hasChatWrite(candidate.user_scopes));
  return row ? toIdentity(row) : null;
}

async function markDenied(database: Database, request: DelegationRequestRecord, now: Date, prismUserId: string | null): Promise<void> {
  await database.query(
    `update slack_delivery_delegation_requests
     set state = 'denied', payload_envelope = null, approval_handle_envelope = null,
         return_state_envelope = null, oauth_resume_handle_hash = null,
         terminal_at = $2, updated_at = $2
     where id = $1`,
    [request.id, now]
  );
  await insertActivityAuditRecord(database, {
    prismUserId,
    activityType: "delegated_delivery_denied",
    endpoint: `/v1/prism/delegations/slack-message/${request.id}/deny`,
    slackMethod: "chat.postMessage",
    actionCategory: "messages.write",
    surface: surfaceForChannel(request.channelId),
    objectType: "channel",
    objectId: request.channelId,
    executionMode: "user",
    status: "denied",
    requestId: request.id,
    upstreamCalled: false,
    occurredAt: now
  });
}

async function expireRequest(database: Database, request: DelegationRequestRecord, now: Date): Promise<void> {
  const expired = await database.query(
    `update slack_delivery_delegation_requests
     set state = 'expired', payload_envelope = null, approval_handle_envelope = null,
         return_state_envelope = null, oauth_resume_handle_hash = null,
         terminal_at = $2, updated_at = $2
     where id = $1 and state = 'pending'`,
    [request.id, now]
  );
  if (expired.rowCount !== 1) return;
  await insertActivityAuditRecord(database, {
    activityType: "delegated_delivery_expired",
    slackMethod: "chat.postMessage",
    actionCategory: "messages.write",
    surface: surfaceForChannel(request.channelId),
    objectType: "channel",
    objectId: request.channelId,
    executionMode: "user",
    status: "expired",
    requestId: request.id,
    upstreamCalled: false,
    occurredAt: now
  });
}

async function insertProofReplay(database: Database, jkt: string, jtiHash: string, expiresAt: Date, now: Date): Promise<void> {
  const result = await database.query(
    `insert into slack_delivery_dpop_replay (dpop_jkt, jti_hash, expires_at, created_at)
     values ($1, $2, $3, $4)
     on conflict (dpop_jkt, jti_hash) do nothing`,
    [jkt, jtiHash, expiresAt, now]
  );
  if (result.rowCount !== 1) throw new DelegatedDeliveryStoreError("proof_replay");
}

async function consumeRequestRateLimits(database: Database, input: {
  clientId: string;
  sourceKey: string;
  expectedPrismUserId: string;
  channelId: string;
  now: Date;
  limits: DelegatedStoreLimits;
  enforceSourceLimits: boolean;
}): Promise<void> {
  const buckets: Array<[string, number]> = [
    [clientBucketKey(input.clientId), input.limits.maxRequestsPerClient],
    ...(input.enforceSourceLimits
      ? [[input.sourceKey, input.limits.maxRequestsPerSource] as [string, number]]
      : []),
    [userBucketKey(input.clientId, input.expectedPrismUserId), input.limits.maxRequestsPerUser],
    [channelBucketKey(input.clientId, input.channelId), input.limits.maxRequestsPerChannel]
  ];
  for (const [bucket, maximum] of buckets) {
    const retryAfter = await consumeFixedWindow(database, bucket, input.now, input.limits.rateWindowMs, maximum);
    if (retryAfter !== null) throw new DelegatedDeliveryStoreError("rate_limited", retryAfter);
  }
}

async function consumeFixedWindow(database: Database, bucketKey: string, now: Date, windowMs: number, maximum: number): Promise<number | null> {
  const resetAt = new Date(now.getTime() + windowMs);
  const result = await database.query<RateRow>(
    `insert into slack_delivery_rate_limits
       (bucket_key, window_started_at, window_reset_at, request_count)
     values ($1, $2, $3, 1)
     on conflict (bucket_key) do update set
       window_started_at = case when slack_delivery_rate_limits.window_reset_at <= $2 then $2 else slack_delivery_rate_limits.window_started_at end,
       window_reset_at = case when slack_delivery_rate_limits.window_reset_at <= $2 then $3 else slack_delivery_rate_limits.window_reset_at end,
       request_count = case when slack_delivery_rate_limits.window_reset_at <= $2 then 1 else slack_delivery_rate_limits.request_count + 1 end,
       updated_at = $2
     returning request_count, window_reset_at`,
    [bucketKey, now, resetAt]
  );
  const row = result.rows[0];
  if (!row) throw new Error("delegated-rate-limit-unavailable");
  return Number(row.request_count) > maximum ? secondsUntil(now, toDate(row.window_reset_at)) : null;
}

async function cleanupExpiredArtifacts(
  database: Database,
  now: Date,
  statusRetentionMs: number,
  batchSize: number
): Promise<DelegatedDeliveryCleanupResult> {
  const expiredPending = await database.query<{ id: string; channel_id: string }>(
    `with targets as (
       select id from slack_delivery_delegation_requests
       where state = 'pending' and approval_expires_at <= $1
       order by approval_expires_at limit $2 for update skip locked
     )
     update slack_delivery_delegation_requests r
     set state = 'expired', payload_envelope = null, approval_handle_envelope = null,
         return_state_envelope = null, oauth_resume_handle_hash = null,
         terminal_at = $1, updated_at = $1
     from targets where r.id = targets.id
     returning r.id, r.channel_id`,
    [now, batchSize]
  );
  await auditExpiredRequests(database, expiredPending.rows, now);

  const expiredGrants = await database.query(
    `with targets as (
       select id from slack_delivery_grants
       where state in ('active', 'executing') and expires_at <= $1
       order by expires_at limit $2 for update skip locked
     )
     update slack_delivery_grants g
     set state = 'expired', lease_id = null, lease_expires_at = null,
         retry_after = null, terminal_at = coalesce(g.terminal_at, $1), updated_at = $1
     from targets where g.id = targets.id`,
    [now, batchSize]
  );

  const expiredApproved = await database.query<{ id: string; channel_id: string }>(
    `with targets as (
       select r.id from slack_delivery_delegation_requests r
       where r.state = 'approved'
         and (
           r.delivery_expires_at <= $1
           or (
             not exists (
               select 1 from slack_delivery_grants g where g.request_id = r.id
             )
             and not exists (
               select 1 from slack_delivery_authorization_codes c
               where c.request_id = r.id and c.used_at is null and c.expires_at > $1
             )
           )
         )
       order by r.delivery_expires_at limit $2 for update of r skip locked
     )
     update slack_delivery_delegation_requests r
     set state = 'expired', payload_envelope = null, approval_handle_envelope = null,
         return_state_envelope = null, oauth_resume_handle_hash = null,
         terminal_at = $1, updated_at = $1
     from targets where r.id = targets.id
     returning r.id, r.channel_id`,
    [now, batchSize]
  );
  await auditExpiredRequests(database, expiredApproved.rows, now);

  const deletedAuthorizationCodes = await boundedDelete(
    database,
    "slack_delivery_authorization_codes",
    "code_hash",
    "expires_at",
    now,
    batchSize
  );
  const deletedDpopReplays = await boundedDelete(
    database,
    "slack_delivery_dpop_replay",
    "(dpop_jkt, jti_hash)",
    "expires_at",
    now,
    batchSize
  );
  const deletedRateBuckets = await boundedDelete(
    database,
    "slack_delivery_rate_limits",
    "bucket_key",
    "window_reset_at",
    now,
    batchSize
  );
  const deletedSlackOAuthStates = await boundedDeleteExpiredSlackOAuthStates(
    database,
    now,
    batchSize
  );
  const deletedTerminalGrants = await boundedDeleteTerminalGrants(database, now, batchSize);
  const deletedTerminalRequests = await boundedDeleteTerminalRequests(
    database,
    new Date(now.getTime() - statusRetentionMs),
    batchSize
  );
  return {
    expiredPendingRequests: expiredPending.rows.length,
    expiredApprovedRequests: expiredApproved.rows.length,
    expiredGrants: expiredGrants.rowCount ?? 0,
    deletedAuthorizationCodes,
    deletedDpopReplays,
    deletedRateBuckets,
    deletedSlackOAuthStates,
    deletedTerminalGrants,
    deletedTerminalRequests
  };
}

async function auditExpiredRequests(
  database: Database,
  rows: Array<{ id: string; channel_id: string }>,
  now: Date
): Promise<void> {
  for (const row of rows) {
    await insertActivityAuditRecord(database, {
      activityType: "delegated_delivery_expired", slackMethod: "chat.postMessage",
      actionCategory: "messages.write", surface: surfaceForChannel(row.channel_id),
      objectType: "channel", objectId: row.channel_id, executionMode: "user",
      status: "expired", requestId: row.id, upstreamCalled: false, occurredAt: now
    });
  }
}

async function boundedDeleteExpiredSlackOAuthStates(
  database: Database,
  now: Date,
  batchSize: number
): Promise<number> {
  const result = await database.query(
    `with targets as (
       select state_hash from slack_oauth_states
       where expires_at <= $1
       order by expires_at limit $2
     )
     delete from slack_oauth_states s using targets where s.state_hash = targets.state_hash`,
    [now, batchSize]
  );
  return result.rowCount ?? 0;
}

async function boundedDeleteTerminalGrants(database: Database, now: Date, batchSize: number): Promise<number> {
  const result = await database.query(
    `with targets as (
       select id from slack_delivery_grants
       where state in ('sent', 'failed', 'cancelled', 'expired', 'outcome_unknown')
         and status_retained_until <= $1
       order by status_retained_until limit $2
     )
     delete from slack_delivery_grants g using targets where g.id = targets.id`,
    [now, batchSize]
  );
  return result.rowCount ?? 0;
}

async function boundedDeleteTerminalRequests(database: Database, retentionCutoff: Date, batchSize: number): Promise<number> {
  const result = await database.query(
    `with targets as (
       select r.id from slack_delivery_delegation_requests r
       where r.state in ('denied', 'cancelled', 'expired')
         and r.terminal_at is not null and r.terminal_at <= $1
         and not exists (select 1 from slack_delivery_grants g where g.request_id = r.id)
         and not exists (
           select 1 from slack_oauth_states s
           where s.delegated_delivery_request_id = r.id
         )
       order by r.terminal_at limit $2
     )
     delete from slack_delivery_delegation_requests r using targets where r.id = targets.id`,
    [retentionCutoff, batchSize]
  );
  return result.rowCount ?? 0;
}

async function boundedDelete(database: Database, table: string, key: string, expiry: string, now: Date, batchSize: number): Promise<number> {
  if (key.startsWith("(")) {
    const result = await database.query(
      `with targets as (select dpop_jkt, jti_hash from ${table} where ${expiry} <= $1 order by ${expiry} limit $2)
       delete from ${table} t using targets where t.dpop_jkt = targets.dpop_jkt and t.jti_hash = targets.jti_hash`,
      [now, batchSize]
    );
    return result.rowCount ?? 0;
  }
  const result = await database.query(
    `with targets as (select ${key} from ${table} where ${expiry} <= $1 order by ${expiry} limit $2)
     delete from ${table} t using targets where t.${key} = targets.${key}`,
    [now, batchSize]
  );
  return result.rowCount ?? 0;
}

function enforceOutstandingCaps(
  row: OutstandingRow | undefined,
  now: Date,
  limits: DelegatedStoreLimits,
  enforceSourceLimits: boolean
): void {
  if (!row) throw new Error("delegated-outstanding-count-unavailable");
  const checks: Array<[number, number, Date | string | null]> = [
    [Number(row.client_count), limits.maxOutstandingPendingPerClient, row.client_retry_at],
    ...(enforceSourceLimits
      ? [[Number(row.source_count), limits.maxOutstandingPendingPerSource, row.source_retry_at] as [number, number, Date | string | null]]
      : []),
    [Number(row.user_count), limits.maxOutstandingPendingPerUser, row.user_retry_at]
  ];
  for (const [count, maximum, retryAt] of checks) {
    if (count >= maximum) throw new DelegatedDeliveryStoreError("rate_limited", secondsUntil(now, retryAt ? toDate(retryAt) : now));
  }
}

function auditForRequest(
  request: Pick<DelegationRequestRecord, "id" | "channelId">,
  identity: DelegatedConsentIdentity,
  activityType: "delegated_delivery_approved" | "delegated_delivery_grant_issued",
  status: "approved" | "issued",
  now: Date
) {
  return {
    prismUserId: identity.prismUserId,
    slackConnectionId: identity.slackConnectionId,
    slackUserId: identity.slackUserId,
    slackTeamId: identity.teamId,
    activityType,
    endpoint: activityType === "delegated_delivery_approved"
      ? `/v1/prism/delegations/slack-message/${request.id}/approve`
      : "/v1/prism/delegations/slack-message/token",
    slackMethod: "chat.postMessage",
    actionCategory: "messages.write",
    surface: surfaceForChannel(request.channelId),
    objectType: "channel",
    objectId: request.channelId,
    executionMode: "user",
    status,
    requestId: request.id,
    upstreamCalled: false,
    occurredAt: now
  } as const;
}

function toRequestRecord(row: RequestRow): DelegationRequestRecord {
  if (!row.payload_envelope || !row.return_state_envelope) {
    throw new DelegatedDeliveryStoreError("lifecycle_conflict");
  }
  return {
    id: row.id,
    clientId: row.client_id,
    externalJobId: row.external_job_id,
    revision: Number(row.revision),
    idempotencyKey: row.idempotency_key,
    callbackUri: row.callback_uri,
    expectedPrismUserId: row.expected_prism_user_id,
    action: "chat.postMessage",
    executionMode: "user",
    teamId: row.team_id,
    channelId: row.channel_id,
    payloadEnvelope: row.payload_envelope,
    payloadSha256: row.payload_sha256,
    returnStateEnvelope: row.return_state_envelope,
    codeChallenge: row.code_challenge,
    dpopJkt: row.dpop_jkt,
    notBefore: toDate(row.not_before),
    approvalExpiresAt: toDate(row.approval_expires_at),
    deliveryExpiresAt: toDate(row.delivery_expires_at),
    state: row.state
  };
}

function toIdentity(row: IdentityRow): DelegatedConsentIdentity {
  return {
    prismUserId: row.prism_user_id,
    slackConnectionId: row.slack_connection_id,
    slackUserId: row.slack_user_id,
    slackUserDisplayName: row.slack_user_display_name,
    teamId: row.team_id,
    teamName: row.team_name
  };
}

function identityFromGrantRow(row: GrantBindingRow): DelegatedConsentIdentity {
  return {
    prismUserId: row.prism_user_id!, slackConnectionId: row.slack_connection_id!, slackUserId: row.slack_user_id!,
    slackUserDisplayName: null, teamId: row.team_id!, teamName: null
  };
}

function toGrantExchangeResult(grantId: string, row: GrantBindingRow): DelegatedGrantExchangeResult {
  return {
    grantId,
    clientId: row.client_id,
    externalJobId: row.external_job_id,
    revision: Number(row.revision),
    prismUserId: row.prism_user_id!,
    slackUserId: row.slack_user_id!,
    teamId: row.team_id!,
    channelId: row.channel_id,
    payloadSha256: row.payload_sha256,
    notBefore: toDate(row.not_before),
    expiresAt: toDate(row.expires_at)
  };
}

function hasChatWrite(scopes: string | null): boolean {
  return typeof scopes === "string" && scopes.split(/[\s,]+/).includes("chat:write");
}

function clientBucketKey(clientId: string): string { return hashSecret(`delegated:rate:client:${clientId}`); }
function sourceBucketKey(clientId: string, source: string): string { return hashSecret(`delegated:rate:source:${clientId}:${source}`); }
function userBucketKey(clientId: string, user: string): string { return hashSecret(`delegated:rate:user:${clientId}:${user}`); }
function channelBucketKey(clientId: string, channel: string): string { return hashSecret(`delegated:rate:channel:${clientId}:${channel}`); }
function surfaceForChannel(channelId: string): "public_channel" | "private_channel" { return channelId.startsWith("G") ? "private_channel" : "public_channel"; }
function secondsUntil(now: Date, retryAt: Date): number {
  return Math.min(3600, Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000)));
}
function toDate(value: Date | string): Date { return value instanceof Date ? value : new Date(value); }

type RequestRow = {
  id: string; client_id: string; external_job_id: string; revision: number | string; idempotency_key: string;
  callback_uri: string; expected_prism_user_id: string; action: "chat.postMessage"; execution_mode: "user";
  team_id: string; channel_id: string; payload_envelope: CredentialEnvelope | null; payload_sha256: string;
  return_state_envelope: CredentialEnvelope | null; code_challenge: string; dpop_jkt: string;
  not_before: Date | string; approval_expires_at: Date | string; delivery_expires_at: Date | string;
  state: "pending" | "approved" | "denied" | "cancelled" | "expired";
};
type IdentityRow = {
  prism_user_id: string; slack_connection_id: string; slack_user_id: string; slack_user_display_name: string | null;
  team_id: string; team_name: string | null; user_scopes: string | null;
};
type GrantBindingRow = {
  request_id: string; client_id: string; external_job_id: string; revision: number | string;
  prism_user_id: string | null; slack_user_id: string | null; team_id: string | null; channel_id: string;
  payload_sha256: string; not_before: Date | string; expires_at: Date | string;
  slack_connection_id: string | null; connection_id_snapshot: string | null; code_hash: string; user_scopes: string | null;
};
type ExecutionRow = {
  grant_id: string; request_id: string; external_job_id: string; revision: number | string;
  dpop_jkt: string; prism_user_id: string; slack_connection_id: string; connection_id_snapshot: string;
  slack_user_id: string; team_id: string; channel_id: string; payload_envelope: CredentialEnvelope | null;
  payload_sha256: string; not_before: Date | string; expires_at: Date | string;
  state: DelegatedGrantExecutionBinding["state"]; slack_ts: string | null; last_error_code: string | null;
  lease_expires_at: Date | string | null; connection_status: string | null; user_scopes: string | null;
};
type OutstandingRow = {
  client_count: number | string; source_count: number | string; user_count: number | string;
  client_retry_at: Date | string | null; source_retry_at: Date | string | null; user_retry_at: Date | string | null;
};
type RateRow = { request_count: number | string; window_reset_at: Date | string };
