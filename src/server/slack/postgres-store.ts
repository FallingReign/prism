import "server-only";

import { randomUUID } from "node:crypto";

import type { CredentialEnvelope } from "../credentials/encryption";
import type { Database } from "../db";
import type { OAuthFlowStore } from "./oauth-flow";
import { hashSecret } from "./oauth-flow";
import type { RefreshStore } from "./refresh";

export function createPostgresOAuthFlowStore(database: Database): OAuthFlowStore {
  return {
    async saveOAuthState(input) {
      await database.query(
        "insert into slack_oauth_states (state_hash, redirect_uri, expires_at) values ($1, $2, $3)",
        [input.stateHash, input.redirectUri, input.expiresAt]
      );
    },
    async consumeOAuthState({ stateHash, now }) {
      const result = await database.query<{ redirect_uri: string }>(
        `update slack_oauth_states
         set used_at = $2
         where state_hash = $1 and used_at is null and expires_at > $2
         returning redirect_uri`,
        [stateHash, now]
      );
      const row = result.rows[0];
      return row ? { redirectUri: row.redirect_uri } : null;
    },
    async upsertPrismUser(input) {
      const result = await database.query<{ id: string }>(
        `insert into prism_users (id, slack_team_id, slack_user_id, slack_enterprise_id)
         values ($1, $2, $3, $4)
         on conflict (slack_team_id, slack_user_id)
         do update set slack_enterprise_id = excluded.slack_enterprise_id, updated_at = now()
         returning id`,
        [randomUUID(), input.slackTeamId, input.slackUserId, input.slackEnterpriseId]
      );
      return { id: result.rows[0]!.id };
    },
    async upsertSlackConnection(input) {
      const result = await database.query<{ id: string }>(
        `insert into slack_connections
          (id, prism_user_id, team_id, team_name, enterprise_id, enterprise_name, authed_user_id, app_id, bot_scopes, user_scopes, status, last_error_class)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'healthy', null)
         on conflict (team_id, authed_user_id)
         do update set
           prism_user_id = excluded.prism_user_id,
           team_name = excluded.team_name,
           enterprise_id = excluded.enterprise_id,
           enterprise_name = excluded.enterprise_name,
           app_id = excluded.app_id,
           bot_scopes = excluded.bot_scopes,
           user_scopes = excluded.user_scopes,
           status = 'healthy',
           last_error_class = null,
           updated_at = now()
         returning id`,
        [
          randomUUID(),
          input.prismUserId,
          input.teamId,
          input.teamName,
          input.enterpriseId,
          input.enterpriseName,
          input.authedUserId,
          input.appId,
          input.botScopes,
          input.userScopes
        ]
      );
      return { id: result.rows[0]!.id };
    },
    async saveSlackCredential(input) {
      await saveCredential(database, input);
    },
    async createWebsiteSession(input) {
      await database.query(
        "insert into prism_sessions (session_token_hash, prism_user_id, expires_at) values ($1, $2, $3)",
        [input.sessionTokenHash, input.prismUserId, input.expiresAt]
      );
    }
  };
}

export function createPostgresRefreshStore(database: Database): RefreshStore {
  return {
    async getCredentialForRefresh({ connectionId, kind }) {
      const result = await database.query<{
        connection_id: string;
        kind: "bot" | "user";
        token_type: string | null;
        access_token_envelope: CredentialEnvelope;
        refresh_token_envelope: CredentialEnvelope | null;
        expires_at: Date | null;
        scopes: string | null;
      }>(
        `select connection_id, kind, token_type, access_token_envelope, refresh_token_envelope, expires_at, scopes
         from slack_credentials where connection_id = $1 and kind = $2`,
        [connectionId, kind]
      );
      const row = result.rows[0];
      return row
        ? {
            connectionId: row.connection_id,
            kind: row.kind,
            tokenType: row.token_type,
            accessTokenEnvelope: row.access_token_envelope,
            refreshTokenEnvelope: row.refresh_token_envelope,
            expiresAt: row.expires_at,
            scopes: row.scopes
          }
        : null;
    },
    async saveRefreshedCredential(input) {
      await saveCredential(database, input);
    },
    async markConnectionHealthy(connectionId) {
      await database.query(
        "update slack_connections set status = 'healthy', last_error_class = null, updated_at = now() where id = $1",
        [connectionId]
      );
    },
    async markConnectionReauthRequired(connectionId, errorClass) {
      await database.query(
        "update slack_connections set status = 'reauth_required', last_error_class = $2, updated_at = now() where id = $1",
        [connectionId, errorClass]
      );
    }
  };
}

export async function getSlackLinkStatus(database: Database, sessionToken: string | undefined): Promise<
  | { kind: "not_linked" }
  | {
      kind: "linked";
      status: "healthy" | "reauth_required";
      teamId: string | null;
      teamName: string | null;
      enterpriseId: string | null;
      enterpriseName: string | null;
      slackUserId: string;
      lastErrorClass: string | null;
    }
> {
  if (!sessionToken) return { kind: "not_linked" };
  const result = await database.query<{
    status: "healthy" | "reauth_required";
    team_id: string | null;
    team_name: string | null;
    enterprise_id: string | null;
    enterprise_name: string | null;
    authed_user_id: string;
    last_error_class: string | null;
  }>(
    `select c.status, nullif(c.team_id, '') as team_id, nullif(c.team_name, '') as team_name,
            c.enterprise_id, nullif(c.enterprise_name, '') as enterprise_name, c.authed_user_id, c.last_error_class
     from prism_sessions s
     join slack_connections c on c.prism_user_id = s.prism_user_id
     where s.session_token_hash = $1 and s.expires_at > now()
     order by c.updated_at desc
     limit 1`,
    [hashSecret(sessionToken)]
  );
  const row = result.rows[0];
  return row
    ? {
        kind: "linked",
        status: row.status,
        teamId: row.team_id,
        teamName: row.team_name,
        enterpriseId: row.enterprise_id,
        enterpriseName: row.enterprise_name,
        slackUserId: row.authed_user_id,
        lastErrorClass: row.last_error_class
      }
    : { kind: "not_linked" };
}

async function saveCredential(
  database: Database,
  input: {
    connectionId: string;
    kind: "bot" | "user";
    tokenType: string | null;
    accessTokenEnvelope: CredentialEnvelope;
    refreshTokenEnvelope: CredentialEnvelope | null;
    expiresAt: Date | null;
    scopes: string | null;
  }
): Promise<void> {
  await database.query(
    `insert into slack_credentials
       (id, connection_id, kind, token_type, access_token_envelope, refresh_token_envelope, expires_at, scopes)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     on conflict (connection_id, kind)
     do update set
       token_type = excluded.token_type,
       access_token_envelope = excluded.access_token_envelope,
       refresh_token_envelope = excluded.refresh_token_envelope,
       expires_at = excluded.expires_at,
       scopes = excluded.scopes,
       updated_at = now()`,
    [
      randomUUID(),
      input.connectionId,
      input.kind,
      input.tokenType,
      JSON.stringify(input.accessTokenEnvelope),
      input.refreshTokenEnvelope ? JSON.stringify(input.refreshTokenEnvelope) : null,
      input.expiresAt,
      input.scopes
    ]
  );
}
