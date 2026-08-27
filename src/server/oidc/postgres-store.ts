import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { Database } from "../db";
import { hashSecret } from "../slack/oauth-flow";
import { UNATTRIBUTED_OIDC_SOURCE } from "./request-source";

export type OidcPendingAuthorizationRequestInput = {
  requestId?: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod?: "S256";
  expiresAt: Date;
  sourceIdentifier: string;
  now: Date;
  maxOutstandingPerSource: number;
  maxOutstandingPerClient: number;
};

export type OidcPendingAuthorizationRequest = {
  requestId: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: Date;
};

export type OidcSessionIdentity = {
  prismUserId: string;
  slackConnectionId: string;
  slackUserId: string;
  slackUserDisplayName: string | null;
  teamId: string;
  teamName: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
  authTime: Date;
};

export type OidcAuthorizationCode = {
  prismUserId: string;
  slackConnectionId: string;
  clientId: string;
  redirectUri: string;
  nonce: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  authTime: Date;
};

export type OidcAccessTokenIdentity = {
  prismUserId: string;
  slackConnectionId: string;
  clientId: string;
  scope: string;
  slackUserId: string;
  slackUserDisplayName: string | null;
  teamId: string;
  teamName: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
};

export type OidcAuthorizationPermit =
  | { kind: "allowed" }
  | { kind: "limited"; retryAfterSeconds: number };

export type OidcPendingAuthorizationRequestResult =
  | { kind: "created"; requestId: string }
  | { kind: "limited"; retryAfterSeconds: number };

export type OidcStore = {
  consumeAuthorizationRequestPermit(input: {
    clientId: string;
    sourceIdentifier: string;
    now: Date;
    windowMs: number;
    maxRequestsPerSource: number;
    maxRequestsPerClient: number;
    cleanupBatchSize: number;
  }): Promise<OidcAuthorizationPermit>;
  createPendingAuthorizationRequest(input: OidcPendingAuthorizationRequestInput): Promise<OidcPendingAuthorizationRequestResult>;
  loadPendingAuthorizationRequest(input: { requestId: string; now: Date }): Promise<OidcPendingAuthorizationRequest | null>;
  consumePendingAuthorizationRequest(input: { requestId: string; now: Date }): Promise<OidcPendingAuthorizationRequest | null>;
  resolveEligiblePrismSessionIdentity(input: { sessionToken?: string; sessionTokenHash?: string; now: Date }): Promise<OidcSessionIdentity | null>;
  issueAuthorizationCode(input: {
    requestId?: string;
    clientId: string;
    prismUserId: string;
    slackConnectionId: string;
    redirectUri: string;
    nonce: string;
    scope: string;
    codeChallenge: string;
    codeChallengeMethod?: "S256";
    authTime: Date;
    expiresAt: Date;
    now?: Date;
  }): Promise<{ code: string }>;
  consumeAuthorizationCode(input: { code: string; clientId: string; redirectUri: string; codeVerifier: string; now: Date }): Promise<OidcAuthorizationCode | null>;
  exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    now: Date;
    accessTokenExpiresAt: Date;
  }): Promise<{ token: string; authorizationCode: OidcAuthorizationCode } | null>;
  issueAccessToken(input: { clientId: string; prismUserId: string; slackConnectionId: string; scope: string; expiresAt: Date; token?: string }): Promise<{ token: string }>;
  resolveAccessToken(input: { token: string; now: Date }): Promise<OidcAccessTokenIdentity | null>;
  resolvePlaytestInitialAdminEligibility(input: { prismUserId: string }): Promise<boolean>;
};

export function createPostgresOidcStore(database: Database): OidcStore {
  return {
    async consumeAuthorizationRequestPermit(input) {
      return database.transaction(async (transactionDatabase) => {
        await cleanupExpiredOidcArtifacts(transactionDatabase, input.now, input.cleanupBatchSize);

        const clientPermit = await consumeFixedWindow(
          transactionDatabase,
          clientBucketKey(input.clientId),
          input.now,
          input.windowMs,
          input.maxRequestsPerClient
        );
        if (clientPermit.kind === "limited") return clientPermit;

        if (input.sourceIdentifier === UNATTRIBUTED_OIDC_SOURCE) return { kind: "allowed" };
        return consumeFixedWindow(
          transactionDatabase,
          sourceBucketKey(input.clientId, input.sourceIdentifier),
          input.now,
          input.windowMs,
          input.maxRequestsPerSource
        );
      });
    },

    async createPendingAuthorizationRequest(input) {
      const requestId = input.requestId ?? randomOpaqueValue();
      return database.transaction(async (transactionDatabase) => {
        const clientKey = clientBucketKey(input.clientId);
        const sourceKey = sourceBucketKey(input.clientId, input.sourceIdentifier);
        // Transaction-scoped advisory locks serialize the cap check across all
        // Prism processes without depending on a rate-bucket row surviving
        // cleanup. Always acquire client before source to avoid deadlocks.
        await transactionDatabase.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [clientKey]
        );
        if (input.sourceIdentifier !== UNATTRIBUTED_OIDC_SOURCE) {
          await transactionDatabase.query(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            [sourceKey]
          );
        }

        const outstanding = await transactionDatabase.query<OutstandingPendingRow>(
          `select count(*)::integer as client_outstanding,
                  count(*) filter (where source_key = $2)::integer as source_outstanding,
                  min(expires_at) as client_retry_at,
                  min(expires_at) filter (where source_key = $2) as source_retry_at
           from oidc_authorization_requests
           where client_id = $1 and consumed_at is null and expires_at > $3`,
          [input.clientId, sourceKey, input.now]
        );
        const counts = outstanding.rows[0];
        if (!counts) throw new Error("oidc-outstanding-count-unavailable");
        if (Number(counts.client_outstanding) >= input.maxOutstandingPerClient) {
          return {
            kind: "limited" as const,
            retryAfterSeconds: secondsUntil(input.now, toOptionalDate(counts.client_retry_at))
          };
        }
        if (
          input.sourceIdentifier !== UNATTRIBUTED_OIDC_SOURCE &&
          Number(counts.source_outstanding) >= input.maxOutstandingPerSource
        ) {
          return {
            kind: "limited" as const,
            retryAfterSeconds: secondsUntil(input.now, toOptionalDate(counts.source_retry_at))
          };
        }

        await transactionDatabase.query(
          `insert into oidc_authorization_requests
            (id, client_id, redirect_uri, state, nonce, scope, code_challenge,
             code_challenge_method, expires_at, source_key)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            requestId,
            input.clientId,
            input.redirectUri,
            input.state,
            input.nonce,
            input.scope,
            input.codeChallenge,
            input.codeChallengeMethod ?? "S256",
            input.expiresAt,
            sourceKey
          ]
        );
        return { kind: "created" as const, requestId };
      });
    },

    async loadPendingAuthorizationRequest({ requestId, now }) {
      const result = await database.query<PendingRow>(
        `select id, client_id, redirect_uri, state, nonce, scope, code_challenge,
                code_challenge_method, expires_at
         from oidc_authorization_requests
         where id = $1 and consumed_at is null and expires_at > $2`,
        [requestId, now]
      );
      return result.rows[0] ? toPendingRequest(result.rows[0]) : null;
    },

    async consumePendingAuthorizationRequest({ requestId, now }) {
      const result = await database.query<PendingRow>(
        `update oidc_authorization_requests
         set consumed_at = $2
         where id = $1 and consumed_at is null and expires_at > $2
         returning id, client_id, redirect_uri, state, nonce, scope, code_challenge,
                   code_challenge_method, expires_at`,
        [requestId, now]
      );
      return result.rows[0] ? toPendingRequest(result.rows[0]) : null;
    },

    async resolveEligiblePrismSessionIdentity({ sessionToken, sessionTokenHash, now }) {
      const tokenHash = sessionTokenHash ?? (sessionToken ? hashSecret(sessionToken) : null);
      if (!tokenHash) return null;
      const result = await database.query<SessionIdentityRow>(
        `select s.prism_user_id, c.id as slack_connection_id,
                c.authed_user_id as slack_user_id,
                nullif(c.authed_user_display_name, '') as slack_user_display_name,
                c.team_id, nullif(c.team_name, '') as team_name,
                c.enterprise_id, nullif(c.enterprise_name, '') as enterprise_name,
                s.created_at as auth_time
         from prism_sessions s
         join prism_users u on u.id = s.prism_user_id
         join slack_connections c on c.prism_user_id = u.id
         where s.session_token_hash = $1 and s.expires_at > $2
           and c.status = 'healthy'
         order by c.updated_at desc
         limit 1`,
        [tokenHash, now]
      );
      const row = result.rows[0];
      return row ? toSessionIdentity(row) : null;
    },

    async issueAuthorizationCode(input) {
      const code = randomOpaqueValue();
      const write = async (transactionDatabase: Database): Promise<void> => {
        if (input.requestId) {
          // The pending request is the authority for all client-controlled values.
          // This single statement makes request consumption and code issuance one
          // all-or-nothing operation; concurrent attempts can produce one code only.
          const issued = await transactionDatabase.query(
            `with consumed_request as (
               update oidc_authorization_requests
               set consumed_at = $2
               where id = $1 and consumed_at is null and expires_at > $2
                 and exists (
                   select 1 from slack_connections c
                   where c.id = $5 and c.prism_user_id = $4 and c.status = 'healthy'
                 )
               returning client_id, redirect_uri, nonce, scope, code_challenge, code_challenge_method
             )
             insert into oidc_authorization_codes
               (code_hash, request_id, client_id, prism_user_id, slack_connection_id,
                redirect_uri, nonce, scope, code_challenge, code_challenge_method,
                auth_time, expires_at)
             select $3, $1, p.client_id, $4, $5,
                    p.redirect_uri, p.nonce, p.scope, p.code_challenge, p.code_challenge_method,
                    $6, $7
             from consumed_request p
             returning code_hash`,
            [input.requestId, input.now ?? input.authTime, hashSecret(code), input.prismUserId, input.slackConnectionId, input.authTime, input.expiresAt]
          );
          if (!issued.rows[0]) throw new Error("oidc-authorization-request-unavailable");
          return;
        }
        const issued = await transactionDatabase.query(
          `insert into oidc_authorization_codes
            (code_hash, request_id, client_id, prism_user_id, slack_connection_id,
             redirect_uri, nonce, scope, code_challenge, code_challenge_method,
             auth_time, expires_at)
           select $1, null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
           where exists (
             select 1 from slack_connections c
             where c.id = $4 and c.prism_user_id = $3 and c.status = 'healthy'
           )
           returning code_hash`,
          [hashSecret(code), input.clientId, input.prismUserId, input.slackConnectionId, input.redirectUri, input.nonce, input.scope, input.codeChallenge, input.codeChallengeMethod ?? "S256", input.authTime, input.expiresAt]
        );
        if (!issued.rows[0]) throw new Error("oidc-authorization-code-subject-unavailable");
      };
      await database.transaction(write);
      return { code };
    },

    async consumeAuthorizationCode({ code, clientId, redirectUri, codeVerifier, now }) {
      if (!isValidCodeVerifier(codeVerifier)) return null;
      const codeChallenge = pkceChallenge(codeVerifier);
      const result = await database.query<AuthorizationCodeRow>(
        `update oidc_authorization_codes
         set used_at = $5
         where code_hash = $1 and client_id = $2 and redirect_uri = $3
           and code_challenge = $4 and code_challenge_method = 'S256'
           and used_at is null and expires_at > $5
           and exists (
             select 1 from slack_connections c
             where c.id = oidc_authorization_codes.slack_connection_id
               and c.prism_user_id = oidc_authorization_codes.prism_user_id
               and c.status = 'healthy'
           )
         returning prism_user_id, slack_connection_id, client_id, redirect_uri,
                   nonce, scope, code_challenge, code_challenge_method, auth_time`,
        [hashSecret(code), clientId, redirectUri, codeChallenge, now]
      );
      const row = result.rows[0];
      return row ? toAuthorizationCode(row) : null;
    },

    async exchangeAuthorizationCode({ code, clientId, redirectUri, codeVerifier, now, accessTokenExpiresAt }) {
      if (!isValidCodeVerifier(codeVerifier)) return null;
      const token = randomOpaqueValue();
      const result = await database.query<AuthorizationCodeRow>(
        `with consumed_code as (
           update oidc_authorization_codes
           set used_at = $5
           where code_hash = $1 and client_id = $2 and redirect_uri = $3
             and code_challenge = $4 and code_challenge_method = 'S256'
             and used_at is null and expires_at > $5
             and exists (
               select 1 from slack_connections c
               where c.id = oidc_authorization_codes.slack_connection_id
                 and c.prism_user_id = oidc_authorization_codes.prism_user_id
                 and c.status = 'healthy'
             )
           returning prism_user_id, slack_connection_id, client_id, redirect_uri,
                     nonce, scope, code_challenge, code_challenge_method, auth_time
         ), issued_access_token as (
           insert into oidc_access_tokens
             (token_hash, client_id, prism_user_id, slack_connection_id, scope, expires_at)
           select $6, client_id, prism_user_id, slack_connection_id, scope, $7
           from consumed_code
           returning token_hash
         )
         select c.prism_user_id, c.slack_connection_id, c.client_id, c.redirect_uri,
                c.nonce, c.scope, c.code_challenge, c.code_challenge_method, c.auth_time
         from consumed_code c
         join issued_access_token i on true`,
        [hashSecret(code), clientId, redirectUri, pkceChallenge(codeVerifier), now, hashSecret(token), accessTokenExpiresAt]
      );
      const authorizationCode = result.rows[0];
      return authorizationCode ? { token, authorizationCode: toAuthorizationCode(authorizationCode) } : null;
    },

    async issueAccessToken(input) {
      const token = input.token ?? randomOpaqueValue();
      const issued = await database.query(
        `insert into oidc_access_tokens
          (token_hash, client_id, prism_user_id, slack_connection_id, scope, expires_at)
         select $1, $2, $3, $4, $5, $6
         where exists (
           select 1 from slack_connections c
           where c.id = $4 and c.prism_user_id = $3 and c.status = 'healthy'
         )
         returning token_hash`,
        [hashSecret(token), input.clientId, input.prismUserId, input.slackConnectionId, input.scope, input.expiresAt]
      );
      if (!issued.rows[0]) throw new Error("oidc-access-token-subject-unavailable");
      return { token };
    },

    async resolveAccessToken({ token, now }) {
      const result = await database.query<AccessTokenRow>(
        `select t.prism_user_id, t.slack_connection_id, t.client_id, t.scope,
                c.authed_user_id as slack_user_id,
                nullif(c.authed_user_display_name, '') as slack_user_display_name,
                c.team_id, nullif(c.team_name, '') as team_name,
                c.enterprise_id, nullif(c.enterprise_name, '') as enterprise_name
         from oidc_access_tokens t
         join slack_connections c on c.id = t.slack_connection_id
                                 and c.prism_user_id = t.prism_user_id
         where t.token_hash = $1 and t.revoked_at is null and t.expires_at > $2
           and c.status = 'healthy'`,
        [hashSecret(token), now]
      );
      const row = result.rows[0];
      return row
        ? {
            prismUserId: row.prism_user_id,
            slackConnectionId: row.slack_connection_id,
            clientId: row.client_id,
            scope: row.scope,
            slackUserId: row.slack_user_id,
            slackUserDisplayName: row.slack_user_display_name,
            teamId: row.team_id,
            teamName: row.team_name,
            enterpriseId: row.enterprise_id,
            enterpriseName: row.enterprise_name
          }
        : null;
    },

    async resolvePlaytestInitialAdminEligibility({ prismUserId }) {
      const result = await database.query<{ eligible: boolean }>(
        `select exists (
           select 1
           from prism_configuration_admins
           where prism_user_id = $1
             and role = 'global_configuration_admin'
             and revoked_at is null
         ) as eligible`,
        [prismUserId]
      );
      return result.rows[0]?.eligible === true;
    }
  };
}

async function cleanupExpiredOidcArtifacts(database: Database, now: Date, batchSize: number): Promise<void> {
  await database.query(
    `with expired_rows as (
       select token_hash from oidc_access_tokens
       where expires_at <= $1
       order by expires_at
       limit $2
     )
     delete from oidc_access_tokens target
     using expired_rows
     where target.token_hash = expired_rows.token_hash`,
    [now, batchSize]
  );
  await database.query(
    `with expired_rows as (
       select code_hash from oidc_authorization_codes
       where expires_at <= $1
       order by expires_at
       limit $2
     )
     delete from oidc_authorization_codes target
     using expired_rows
     where target.code_hash = expired_rows.code_hash`,
    [now, batchSize]
  );
  await database.query(
    `with expired_rows as (
       select state_hash from slack_oauth_states
       where expires_at <= $1
       order by expires_at
       limit $2
     )
     delete from slack_oauth_states target
     using expired_rows
     where target.state_hash = expired_rows.state_hash`,
    [now, batchSize]
  );
  await database.query(
    `with expired_rows as (
       select id from oidc_authorization_requests
       where expires_at <= $1
       order by expires_at
       limit $2
     )
     delete from oidc_authorization_requests target
     using expired_rows
     where target.id = expired_rows.id`,
    [now, batchSize]
  );
  await database.query(
    `with expired_rows as (
       select bucket_key from oidc_authorization_rate_limits
       where window_reset_at <= $1
       order by window_reset_at
       limit $2
       for update skip locked
     )
     delete from oidc_authorization_rate_limits target
     using expired_rows
     where target.bucket_key = expired_rows.bucket_key
       and target.window_reset_at <= $1`,
    [now, batchSize]
  );
}

async function consumeFixedWindow(
  database: Database,
  bucketKey: string,
  now: Date,
  windowMs: number,
  maxRequests: number
): Promise<OidcAuthorizationPermit> {
  const resetAt = new Date(now.getTime() + windowMs);
  const inserted = await database.query(
    `insert into oidc_authorization_rate_limits
       (bucket_key, window_started_at, window_reset_at, request_count)
     values ($1, $2, $3, 1)
     on conflict (bucket_key) do nothing`,
    [bucketKey, now, resetAt]
  );
  if (inserted.rowCount === 1) return { kind: "allowed" };

  const existing = await database.query<AuthorizationRateLimitRow>(
    `select request_count, window_reset_at
     from oidc_authorization_rate_limits
     where bucket_key = $1
     for update`,
    [bucketKey]
  );
  const row = existing.rows[0];
  if (!row) throw new Error("oidc-rate-limit-bucket-missing");
  const currentResetAt = toDate(row.window_reset_at);
  if (currentResetAt <= now) {
    await database.query(
      `update oidc_authorization_rate_limits
       set window_started_at = $2, window_reset_at = $3,
           request_count = 1, updated_at = now()
       where bucket_key = $1`,
      [bucketKey, now, resetAt]
    );
    return { kind: "allowed" };
  }
  if (Number(row.request_count) >= maxRequests) {
    return { kind: "limited", retryAfterSeconds: secondsUntil(now, currentResetAt) };
  }
  await database.query(
    `update oidc_authorization_rate_limits
     set request_count = request_count + 1, updated_at = now()
     where bucket_key = $1`,
    [bucketKey]
  );
  return { kind: "allowed" };
}

function clientBucketKey(clientId: string): string {
  return hashSecret(`oidc-authorize:client:${clientId}`);
}

function sourceBucketKey(clientId: string, sourceIdentifier: string): string {
  return hashSecret(`oidc-authorize:source:${clientId}:${sourceIdentifier}`);
}

function secondsUntil(now: Date, retryAt: Date | null): number {
  if (!retryAt) return 1;
  return Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000));
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toOptionalDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function randomOpaqueValue(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function isValidCodeVerifier(value: string): boolean {
  return value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(value);
}

type PendingRow = {
  id: string; client_id: string; redirect_uri: string; state: string; nonce: string; scope: string;
  code_challenge: string; code_challenge_method: "S256"; expires_at: Date;
};

type SessionIdentityRow = {
  prism_user_id: string; slack_connection_id: string; slack_user_id: string; slack_user_display_name: string | null;
  team_id: string; team_name: string | null; enterprise_id: string | null; enterprise_name: string | null; auth_time: Date;
};

type AuthorizationCodeRow = {
  prism_user_id: string; slack_connection_id: string; client_id: string; redirect_uri: string; nonce: string;
  scope: string; code_challenge: string; code_challenge_method: "S256"; auth_time: Date;
};

type AccessTokenRow = {
  prism_user_id: string; slack_connection_id: string; client_id: string; scope: string; slack_user_id: string;
  slack_user_display_name: string | null; team_id: string; team_name: string | null;
  enterprise_id: string | null; enterprise_name: string | null;
};

type AuthorizationRateLimitRow = {
  request_count: number | string;
  window_reset_at: Date | string;
};

type OutstandingPendingRow = {
  client_outstanding: number | string;
  source_outstanding: number | string;
  client_retry_at: Date | string | null;
  source_retry_at: Date | string | null;
};

function toPendingRequest(row: PendingRow): OidcPendingAuthorizationRequest {
  return { requestId: row.id, clientId: row.client_id, redirectUri: row.redirect_uri, state: row.state, nonce: row.nonce, scope: row.scope, codeChallenge: row.code_challenge, codeChallengeMethod: row.code_challenge_method, expiresAt: row.expires_at };
}

function toSessionIdentity(row: SessionIdentityRow): OidcSessionIdentity {
  return { prismUserId: row.prism_user_id, slackConnectionId: row.slack_connection_id, slackUserId: row.slack_user_id, slackUserDisplayName: row.slack_user_display_name, teamId: row.team_id, teamName: row.team_name, enterpriseId: row.enterprise_id, enterpriseName: row.enterprise_name, authTime: row.auth_time };
}

function toAuthorizationCode(row: AuthorizationCodeRow): OidcAuthorizationCode {
  return { prismUserId: row.prism_user_id, slackConnectionId: row.slack_connection_id, clientId: row.client_id, redirectUri: row.redirect_uri, nonce: row.nonce, scope: row.scope, codeChallenge: row.code_challenge, codeChallengeMethod: row.code_challenge_method, authTime: row.auth_time };
}
