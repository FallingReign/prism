import "server-only";

import { randomUUID } from "node:crypto";

import { insertActivityAuditRecord } from "../audit/postgres-store";
import type { Database } from "../db";
import { hashSecret } from "../slack/oauth-flow";
import type { LocalToolTokenStore, ResolvedDeveloperToken } from "./local-tool-status";
import type { CapabilityMap, TokenProfilePreset } from "./presets";
import type { TokenProfileMetadata, TokenProfileStore } from "./service";

export function createPostgresTokenProfileStore(database: Database): TokenProfileStore & LocalToolTokenStore {
  return {
    async resolveOwner({ sessionToken, now }) {
      const result = await database.query<{
        prism_user_id: string;
        slack_connection_id: string;
        status: "healthy" | "reauth_required";
      }>(
        `select s.prism_user_id, c.id as slack_connection_id, c.status
         from prism_sessions s
         join slack_connections c on c.prism_user_id = s.prism_user_id
         where s.session_token_hash = $1 and s.expires_at > $2
         order by c.updated_at desc
         limit 1`,
        [hashSecret(sessionToken), now]
      );
      const row = result.rows[0];
      return row ? { prismUserId: row.prism_user_id, slackConnectionId: row.slack_connection_id, slackStatus: row.status } : null;
    },
    async listProfiles(owner) {
      const result = await database.query<TokenProfileRow>(
        `select id, prism_user_id, slack_connection_id, name, name_normalized, intended_use, preset,
                capability_map, expires_at, status, created_at, updated_at
         from token_profiles
         where prism_user_id = $1 and slack_connection_id = $2 and status = 'active'
         order by created_at desc`,
        [owner.prismUserId, owner.slackConnectionId]
      );
      return result.rows.map(toTokenProfileMetadata);
    },
    async insertProfileWithVerifier(input) {
      try {
        return await database.transaction(async (tx) => {
          const duplicate = await tx.query(
            "select 1 from token_profiles where prism_user_id = $1 and name_normalized = $2 and status = 'active' limit 1",
            [input.prismUserId, input.nameNormalized]
          );
          if (duplicate.rowCount) return { kind: "duplicate_name" as const };

          const profile = await tx.query<TokenProfileRow>(
            `insert into token_profiles
               (id, prism_user_id, slack_connection_id, name, name_normalized, intended_use, preset, capability_map, expires_at, status)
             values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
             returning id, prism_user_id, slack_connection_id, name, name_normalized, intended_use, preset,
                       capability_map, expires_at, status, created_at, updated_at`,
            [
              randomUUID(),
              input.prismUserId,
              input.slackConnectionId,
              input.name,
              input.nameNormalized,
              input.intendedUse,
              input.preset,
              JSON.stringify(input.capabilityMap),
              input.expiresAt,
              input.status
            ]
          );
          const row = profile.rows[0]!;
          await tx.query(
            `insert into prism_developer_tokens
               (id, token_profile_id, token_hash, hash_algorithm, pepper_id, expires_at)
             values ($1, $2, $3, $4, $5, $6)`,
            [randomUUID(), row.id, input.verifier.tokenHash, input.verifier.algorithm, input.verifier.pepperId, input.expiresAt]
          );
          if (input.audit) {
            await insertActivityAuditRecord(tx, {
             prismUserId: input.prismUserId,
             slackConnectionId: input.slackConnectionId,
             tokenProfileId: row.id,
             tokenProfileName: row.name,
             activityType: "token_profile_created",
             endpoint: input.audit.endpoint,
             actionCategory: input.preset,
             status: "created",
             httpStatus: 201,
             requestId: input.audit.requestId,
             upstreamCalled: false
            });
          }
          return { kind: "created" as const, profile: toTokenProfileMetadata(row) };
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { kind: "duplicate_name" };
        throw error;
      }
    },
    async resolveDeveloperToken({ tokenHash }) {
      const result = await database.query<DeveloperTokenResolutionRow>(
        `select
          p.prism_user_id,
           p.id as token_profile_id,
           p.name as token_profile_name,
           p.slack_connection_id,
           t.expires_at as token_expires_at,
           t.revoked_at as token_revoked_at,
           p.status as profile_status,
           p.expires_at as profile_expires_at,
           p.preset,
           p.capability_map,
           c.status as slack_status,
           c.team_id as slack_team_id,
           c.enterprise_id as slack_enterprise_id,
           c.authed_user_id as slack_user_id,
           c.last_error_class as slack_last_error_class,
           exists(select 1 from slack_credentials sc where sc.connection_id = c.id and sc.kind = 'user') as has_user_credential,
           exists(select 1 from slack_credentials sc where sc.connection_id = c.id and sc.kind = 'bot') as has_bot_credential
         from prism_developer_tokens t
         join token_profiles p on p.id = t.token_profile_id
         join slack_connections c on c.id = p.slack_connection_id
         where t.token_hash = $1
         limit 1`,
        [tokenHash]
      );
      const row = result.rows[0];
      return row ? toResolvedDeveloperToken(row) : null;
    }
  };
}

type TokenProfileRow = {
  id: string;
  prism_user_id: string;
  slack_connection_id: string;
  name: string;
  name_normalized: string;
  intended_use: string;
  preset: TokenProfilePreset;
  capability_map: CapabilityMap;
  expires_at: Date | null;
  status: "active";
  created_at: Date;
  updated_at: Date;
};

type DeveloperTokenResolutionRow = {
  prism_user_id: string;
  token_profile_id: string;
  token_profile_name: string;
  slack_connection_id: string;
  token_expires_at: Date | null;
  token_revoked_at: Date | null;
  profile_status: "active" | "bootstrap" | "revoked";
  profile_expires_at: Date | null;
  preset: TokenProfilePreset;
  capability_map: CapabilityMap;
  slack_status: "healthy" | "reauth_required";
  slack_team_id: string | null;
  slack_enterprise_id: string | null;
  slack_user_id: string | null;
  slack_last_error_class: string | null;
  has_user_credential: boolean;
  has_bot_credential: boolean;
};

function toTokenProfileMetadata(row: TokenProfileRow): TokenProfileMetadata {
  return {
    id: row.id,
    prismUserId: row.prism_user_id,
    slackConnectionId: row.slack_connection_id,
    name: row.name,
    nameNormalized: row.name_normalized,
    intendedUse: row.intended_use,
    preset: row.preset,
    capabilityMap: row.capability_map,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toResolvedDeveloperToken(row: DeveloperTokenResolutionRow): ResolvedDeveloperToken {
  return {
    prismUserId: row.prism_user_id,
    tokenProfileId: row.token_profile_id,
    tokenProfileName: row.token_profile_name,
    slackConnectionId: row.slack_connection_id,
    tokenExpiresAt: row.token_expires_at,
    tokenRevokedAt: row.token_revoked_at,
    profileStatus: row.profile_status,
    profileExpiresAt: row.profile_expires_at,
    preset: row.preset,
    capabilityMap: row.capability_map,
    slackStatus: row.slack_status,
    slackTeamId: row.slack_team_id,
    slackEnterpriseId: row.slack_enterprise_id,
    slackUserId: row.slack_user_id,
    slackLastErrorClass: row.slack_last_error_class,
    hasUserCredential: row.has_user_credential,
    hasBotCredential: row.has_bot_credential
  };
}

function isUniqueViolation(error: unknown): error is { code: "23505" } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}
