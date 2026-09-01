import "server-only";

import { randomUUID } from "node:crypto";

import { insertActivityAuditRecord } from "../audit/postgres-store";
import type { CredentialCipher, CredentialEnvelope } from "../credentials/encryption";
import type { Database } from "../db";
import { createPostgresSetupBootstrapStore } from "../setup/bootstrap-postgres-store";
import { createPostgresSlackAppConfigurationStore } from "./app-configuration-postgres-store";
import type { SlackConnectionDisplayNameStore, SlackConnectionDisplayRecord } from "./connection-display-names";
import type { OAuthFlowStore } from "./oauth-flow";
import { hashSecret } from "./oauth-flow";
import type { RefreshStore } from "./refresh";
import { parseSlackWorkspaceGrantDisplay, type SlackWorkspaceGrantDisplay } from "./workspace-grant-display";
import { replaceOrganizationWorkspaceGrants } from "./organization-workspace-grant-store";

export function createPostgresOAuthFlowStore(
  database: Database,
  options: { credentialCipher?: CredentialCipher } = {}
): OAuthFlowStore {
  return {
    async transaction(callback) {
      return database.transaction((transactionDatabase) =>
        callback(createPostgresOAuthFlowStore(transactionDatabase, options))
      );
    },
    async saveOAuthState(input) {
      const environmentFingerprint =
        input.configurationBinding.kind === "environment"
          ? input.configurationBinding.fingerprint
          : null;
      const configurationVersionId =
        input.configurationBinding.kind === "database"
          ? input.configurationBinding.versionId
          : null;
      const setupSessionId =
        input.configurationBinding.kind === "database"
          ? input.configurationBinding.setupSessionId
          : null;
      await database.query(
        `insert into slack_oauth_states
           (state_hash, redirect_uri, oidc_authorization_request_id,
            delegated_delivery_request_id, local_app_authorization_id, expires_at,
            slack_app_configuration_version_id, setup_session_id,
            environment_configuration_fingerprint)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.stateHash,
          input.redirectUri,
          input.oidcAuthorizationRequestId ?? null,
          input.delegatedDeliveryRequestId ?? null,
          input.localAppAuthorizationId ?? null,
          input.expiresAt,
          configurationVersionId,
          setupSessionId,
          environmentFingerprint
        ]
      );
    },
    async consumeOAuthState({ stateHash, now }) {
      const result = await database.query<{
        redirect_uri: string;
        oidc_authorization_request_id: string | null;
        delegated_delivery_request_id: string | null;
        local_app_authorization_id: string | null;
        slack_app_configuration_version_id: string | null;
        setup_session_id: string | null;
        environment_configuration_fingerprint: string | null;
      }>(
        `update slack_oauth_states
         set used_at = $2
         where state_hash = $1 and used_at is null and expires_at > $2
         returning redirect_uri, oidc_authorization_request_id,
                   delegated_delivery_request_id, local_app_authorization_id,
                   slack_app_configuration_version_id, setup_session_id,
                   environment_configuration_fingerprint`,
        [stateHash, now]
      );
      const row = result.rows[0];
      if (!row) return null;
      const configurationBinding = row.slack_app_configuration_version_id
        ? row.environment_configuration_fingerprint
          ? null
          : {
              kind: "database" as const,
              versionId: row.slack_app_configuration_version_id,
              setupSessionId: row.setup_session_id ?? null
            }
        : row.environment_configuration_fingerprint && !row.setup_session_id
          ? {
              kind: "environment" as const,
              fingerprint: row.environment_configuration_fingerprint
            }
          : null;
      if (!configurationBinding) return null;
      return {
        redirectUri: row.redirect_uri,
        configurationBinding,
        oidcAuthorizationRequestId: row.oidc_authorization_request_id ?? null,
        delegatedDeliveryRequestId: row.delegated_delivery_request_id ?? null,
        localAppAuthorizationId: row.local_app_authorization_id ?? null
      };
    },
    async upsertPrismUser(input) {
      const organization = input.identityScope === "organization";
      if (organization && input.slackEnterpriseId) {
        const matchingIdentities = await database.query<{ id: string; identity_scope: "workspace" | "organization" }>(
          `select id, identity_scope
           from prism_users
           where slack_user_id = $1 and slack_enterprise_id = $2
           order by case identity_scope when 'workspace' then 0 else 1 end, created_at asc
           for update`,
          [input.slackUserId, input.slackEnterpriseId]
        );
        const workspaceIdentity = matchingIdentities.rows.find((row) => row.identity_scope === "workspace");
        if (workspaceIdentity) {
          const organizationDuplicate = matchingIdentities.rows.some(
            (row) => row.identity_scope === "organization" && row.id !== workspaceIdentity.id
          );
          if (organizationDuplicate) {
            // Do not silently choose between two existing Prism subjects or
            // rewrite their credentials/admin state. A dedicated, audited
            // reconciliation migration is required for this legacy condition.
            throw new Error("slack-organization-identity-reconciliation-required");
          }
          // A normal workspace -> organization upgrade retains the workspace
          // subject, which keeps existing administrator, OIDC and token links.
          return { id: workspaceIdentity.id };
        }
      }
      const result = await database.query<{ id: string }>(
        `insert into prism_users
           (id, identity_scope, identity_scope_id, slack_team_id, slack_user_id, slack_enterprise_id)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (${organization ? "slack_enterprise_id, slack_user_id) where identity_scope = 'organization'" : "slack_team_id, slack_user_id)"}
         do update set
           identity_scope_id = excluded.identity_scope_id,
           slack_enterprise_id = excluded.slack_enterprise_id,
           updated_at = now()
         returning id`,
        [
          randomUUID(),
          input.identityScope,
          organization ? input.slackEnterpriseId : input.slackTeamId,
          input.slackTeamId,
          input.slackUserId,
          input.slackEnterpriseId
        ]
      );
      return { id: result.rows[0]!.id };
    },
    async upsertSlackConnection(input) {
      const result = await database.query<{ id: string }>(
        `insert into slack_connections
          (id, prism_user_id, installation_scope, is_enterprise_install, team_id, team_name,
           enterprise_id, enterprise_name, authed_user_id, app_id, bot_scopes, user_scopes, status, last_error_class)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'healthy', null)
         on conflict (${input.installationScope === "organization"
           ? "app_id, enterprise_id, authed_user_id"
           : "app_id, team_id, authed_user_id"})
         where installation_scope = '${input.installationScope === "organization" ? "organization" : "workspace"}'
         do update set
          prism_user_id = excluded.prism_user_id,
           is_enterprise_install = excluded.is_enterprise_install,
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
          input.installationScope,
          input.isEnterpriseInstall,
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
    async upsertWorkspaceGrant(input) {
      await database.query(
        `insert into slack_connection_workspace_grants
           (id, slack_connection_id, team_id, team_name, status, source, discovered_at, last_verified_at)
         values ($1, $2, $3, $4, 'active', $5, $6, $6)
         on conflict (slack_connection_id, team_id)
         do update set
           team_name = excluded.team_name,
           status = 'active',
           source = excluded.source,
           last_verified_at = excluded.last_verified_at,
           revoked_at = null,
           updated_at = now()`,
        [randomUUID(), input.connectionId, input.teamId, input.teamName, input.source, input.verifiedAt]
      );
    },
    async replaceOrganizationGrants(input) {
      await replaceOrganizationWorkspaceGrants(database, input);
    },
    async saveSlackCredential(input) {
      await saveCredential(database, input);
    },
    async createWebsiteSession(input) {
      await database.query(
        `insert into prism_sessions
           (session_token_hash, prism_user_id, slack_connection_id, expires_at)
         values ($1, $2, $3, $4)`,
        [input.sessionTokenHash, input.prismUserId, input.connectionId, input.expiresAt]
      );
    },
    async finalizeSetupConfiguration(input) {
      if (!options.credentialCipher) {
        throw new Error("slack-configuration-finalizer-unavailable");
      }
      const configurationStore = createPostgresSlackAppConfigurationStore(
        database,
        options.credentialCipher
      );
      await configurationStore.activatePendingConfigurationInTransaction({
        versionId: input.configurationVersionId,
        setupSessionId: input.setupSessionId,
        activatedByPrismUserId: input.prismUserId,
        now: input.now,
        audit: {
          endpoint: "/v1/slack/oauth/callback",
          requestId: input.requestId
        }
      });
      const claim = await createPostgresSetupBootstrapStore(
        database
      ).claimSessionAndConfigurationAdmin({
        setupSessionId: input.setupSessionId,
        configurationVersionId: input.configurationVersionId,
        prismUserId: input.prismUserId,
        now: input.now
      });
      if (!claim) throw new Error("slack-configuration-claim-unavailable");

      await insertActivityAuditRecord(database, {
        prismUserId: input.prismUserId,
        slackConnectionId: input.slackConnectionId,
        slackUserId: input.slackUserId,
        slackTeamId: input.slackTeamId,
        activityType: "configuration_admin_claimed",
        endpoint: "/v1/slack/oauth/callback",
        actionCategory: "settings",
        surface: "configuration_bootstrap",
        objectType: "slack_app_configuration",
        objectId: input.configurationVersionId,
        executionMode: claim.recovery ? "recovery" : "bootstrap",
        status: "created",
        requestId: input.requestId,
        upstreamCalled: false,
        occurredAt: input.now
      });
    }
  };
}

export function createPostgresRefreshStore(database: Database): RefreshStore {
  return {
    async withCredentialRefreshLock({ connectionId, kind }, callback) {
      return database.transaction(async (transactionDatabase) => {
        await transactionDatabase.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`slack-credential-refresh:${connectionId}:${kind}`]
        );
        return callback(createPostgresRefreshStore(transactionDatabase));
      });
    },
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

export type SlackLinkStatus =
  | { kind: "not_linked" }
  | {
      kind: "linked";
      status: "healthy" | "reauth_required";
      installationScope: "workspace" | "organization";
      teamId: string | null;
      teamName: string | null;
      enterpriseId: string | null;
      enterpriseName: string | null;
      slackUserId: string;
      slackUserDisplayName: string | null;
      lastErrorClass: string | null;
      workspaceGrants: SlackWorkspaceGrantDisplay[];
    };

export async function getSlackLinkStatus(database: Database, sessionToken: string | undefined): Promise<SlackLinkStatus> {
  const connection = await getSlackConnectionDisplayRecordForSession(database, sessionToken);
  return connection ? toSlackLinkStatus(connection) : { kind: "not_linked" };
}

export async function getSlackConnectionDisplayRecordForSession(database: Database, sessionToken: string | undefined): Promise<SlackConnectionDisplayRecord | null> {
  if (!sessionToken) return null;
  const result = await database.query<{
    id: string;
    status: "healthy" | "reauth_required";
    installation_scope: "workspace" | "organization";
    team_id: string | null;
    team_name: string | null;
    enterprise_id: string | null;
    enterprise_name: string | null;
    authed_user_id: string;
    authed_user_display_name: string | null;
    display_names_enriched_at: Date | null;
    last_error_class: string | null;
    workspace_grants: unknown;
  }>(
    `select c.id, c.status, c.installation_scope,
            nullif(c.team_id, '') as team_id, nullif(c.team_name, '') as team_name,
            c.enterprise_id, nullif(c.enterprise_name, '') as enterprise_name,
            c.authed_user_id, nullif(c.authed_user_display_name, '') as authed_user_display_name,
            c.display_names_enriched_at, c.last_error_class,
            coalesce((
              select jsonb_agg(
                jsonb_build_object('team_id', g.team_id, 'team_name', nullif(g.team_name, ''))
                order by lower(coalesce(g.team_name, g.team_id)), g.team_id
              )
              from slack_connection_workspace_grants g
              where g.slack_connection_id = c.id and g.status = 'active'
            ), '[]'::jsonb) as workspace_grants
     from prism_sessions s
     join slack_connections c
       on c.id = s.slack_connection_id and c.prism_user_id = s.prism_user_id
     where s.session_token_hash = $1 and s.expires_at > now()
     limit 1`,
    [hashSecret(sessionToken)]
  );
  const row = result.rows[0];
  return row
    ? {
        connectionId: row.id,
        installationScope: row.installation_scope ?? (row.team_id ? "workspace" : "organization"),
        status: row.status,
        teamId: row.team_id,
        teamName: row.team_name,
        enterpriseId: row.enterprise_id,
        enterpriseName: row.enterprise_name,
        slackUserId: row.authed_user_id,
        slackUserDisplayName: row.authed_user_display_name,
        displayNamesEnrichedAt: row.display_names_enriched_at,
        lastErrorClass: row.last_error_class,
        workspaceGrants: parseSlackWorkspaceGrantDisplay(row.workspace_grants)
      }
    : null;
}

export function createPostgresSlackConnectionDisplayNameStore(database: Database): SlackConnectionDisplayNameStore {
  return {
    async claimConnectionDisplayNameEnrichmentAttempt(input) {
      const result = await database.query<{ id: string }>(
        `update slack_connections
         set display_names_enriched_at = $2,
             updated_at = now()
         where id = $1
           and status = 'healthy'
           and (display_names_enriched_at is null or display_names_enriched_at <= $3)
           and (
             (nullif(team_id, '') is not null and nullif(team_name, '') is null)
             or (nullif(enterprise_id, '') is not null and nullif(enterprise_name, '') is null)
             or nullif(authed_user_display_name, '') is null
           )
         returning id`,
        [input.connectionId, input.attemptedAt, input.retryIfAttemptedBefore]
      );
      return result.rowCount === 1;
    },

    async updateConnectionDisplayNames(input) {
      const result = await database.query<{
        id: string;
        status: "healthy" | "reauth_required";
        team_id: string | null;
        team_name: string | null;
        enterprise_id: string | null;
        enterprise_name: string | null;
        authed_user_id: string;
        authed_user_display_name: string | null;
        display_names_enriched_at: Date | null;
        last_error_class: string | null;
      }>(
        `update slack_connections
         set team_name = $2,
             enterprise_name = $3,
             authed_user_display_name = $4,
             display_names_enriched_at = $5,
             updated_at = now()
         where id = $1
         returning id, status, nullif(team_id, '') as team_id, nullif(team_name, '') as team_name,
                   enterprise_id, nullif(enterprise_name, '') as enterprise_name,
                   authed_user_id, nullif(authed_user_display_name, '') as authed_user_display_name,
                   display_names_enriched_at, last_error_class`,
        [input.connectionId, input.teamName, input.enterpriseName, input.slackUserDisplayName, input.enrichedAt]
      );
      const row = result.rows[0];
      if (!row) throw new Error("slack-connection-not-found");
      return {
        connectionId: row.id,
        status: row.status,
        teamId: row.team_id,
        teamName: row.team_name,
        enterpriseId: row.enterprise_id,
        enterpriseName: row.enterprise_name,
        slackUserId: row.authed_user_id,
        slackUserDisplayName: row.authed_user_display_name,
        displayNamesEnrichedAt: row.display_names_enriched_at,
        lastErrorClass: row.last_error_class
      };
    }
  };
}

export function toSlackLinkStatus(connection: SlackConnectionDisplayRecord): Exclude<SlackLinkStatus, { kind: "not_linked" }> {
  return {
    kind: "linked",
    status: connection.status,
    installationScope: connection.installationScope ?? (connection.teamId ? "workspace" : "organization"),
    teamId: connection.teamId,
    teamName: connection.teamName,
    enterpriseId: connection.enterpriseId,
    enterpriseName: connection.enterpriseName,
    slackUserId: connection.slackUserId,
    slackUserDisplayName: connection.slackUserDisplayName,
    lastErrorClass: connection.lastErrorClass,
    workspaceGrants: connection.workspaceGrants ?? []
  };
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
