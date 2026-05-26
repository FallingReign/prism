import "server-only";

import { randomUUID } from "node:crypto";

import { insertActivityAuditRecord } from "../audit/postgres-store";
import type { Database } from "../db";
import { hashSecret } from "../slack/oauth-flow";
import type { LocalToolTokenStore, ResolvedDeveloperToken } from "./local-tool-status";
import type { CapabilityMap, TokenProfilePreset } from "./presets";
import type { TokenProfileDeveloperTokenMetadata, TokenProfileMetadata, TokenProfileStore } from "./service";

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
        `${tokenProfileMetadataSelect()}
         where p.prism_user_id = $1 and p.slack_connection_id = $2 and p.status in ('active', 'revoked')
         order by p.created_at desc`,
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
          return {
            kind: "created" as const,
            profile: {
              ...toTokenProfileMetadata(row),
              developerToken: {
                status: "active",
                createdAt: row.created_at,
                expiresAt: input.expiresAt,
                lastUsedAt: null,
                revokedAt: null,
                overlapExpiresAt: null
              }
            }
          };
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { kind: "duplicate_name" };
        throw error;
      }
    },
    async revokeProfileDeveloperTokens(input) {
      return database.transaction(async (tx) => {
        const existing = await tx.query<TokenProfileRow>(
          `${tokenProfileMetadataSelect()}
           where p.id = $1 and p.prism_user_id = $2 and p.slack_connection_id = $3 and p.status = 'active'
           limit 1`,
          [input.profileId, input.prismUserId, input.slackConnectionId]
        );
        const row = existing.rows[0];
        if (!row) return { kind: "not_found" as const };

        await tx.query(
          `update prism_developer_tokens
           set revoked_at = coalesce(revoked_at, $2),
               is_current = false
           where token_profile_id = $1 and revoked_at is null`,
          [input.profileId, input.now]
        );

        if (input.audit) {
          await insertActivityAuditRecord(tx, {
            prismUserId: input.prismUserId,
            slackConnectionId: input.slackConnectionId,
            tokenProfileId: row.id,
            tokenProfileName: row.name,
            activityType: "token_profile_revoked",
            endpoint: input.audit.endpoint,
            status: "revoked",
            httpStatus: 200,
            requestId: input.audit.requestId,
            upstreamCalled: false
          });
        }

        await tx.query(
          `update token_profiles
           set status = 'revoked',
               updated_at = $2
           where id = $1 and status = 'active'`,
          [input.profileId, input.now]
        );

        return {
          kind: "revoked" as const,
          profile: {
            ...toTokenProfileMetadata(row),
            status: "revoked",
            developerToken: {
              status: "revoked",
              createdAt: row.developer_token_created_at,
              expiresAt: row.developer_token_expires_at,
              lastUsedAt: row.developer_token_last_used_at,
              revokedAt: input.now,
              overlapExpiresAt: null
            }
          }
        };
      });
    },
    async deleteInactiveProfile(input) {
      return database.transaction(async (tx) => {
        const existing = await tx.query<TokenProfileRow>(
          `${tokenProfileMetadataSelect()}
           where p.id = $1 and p.prism_user_id = $2 and p.slack_connection_id = $3 and p.status in ('active', 'revoked')
           limit 1`,
          [input.profileId, input.prismUserId, input.slackConnectionId]
        );
        const row = existing.rows[0];
        if (!row) return { kind: "not_found" as const };

        const profile = toTokenProfileMetadata(row);
        if (profile.status === "active" && profile.developerToken?.status === "active") {
          return { kind: "conflict" as const };
        }

        if (input.audit) {
          await insertActivityAuditRecord(tx, {
            prismUserId: input.prismUserId,
            slackConnectionId: input.slackConnectionId,
            tokenProfileId: row.id,
            tokenProfileName: row.name,
            activityType: "token_profile_deleted",
            endpoint: input.audit.endpoint,
            status: "deleted",
            httpStatus: 200,
            requestId: input.audit.requestId,
            upstreamCalled: false
          });
        }

        await tx.query(
          `delete from token_profiles p
           where p.id = $1
             and p.prism_user_id = $2
             and p.slack_connection_id = $3
             and p.status in ('active', 'revoked')
             and (
               p.status = 'revoked'
               or not exists (
                 select 1
                 from prism_developer_tokens t
                 where t.token_profile_id = p.id
                   and t.is_current = true
                   and t.revoked_at is null
                   and (t.expires_at is null or t.expires_at > $4)
               )
             )`,
          [input.profileId, input.prismUserId, input.slackConnectionId, input.now]
        );

        return { kind: "deleted" as const, profile };
      });
    },
    async rotateProfileDeveloperToken(input) {
      return database.transaction(async (tx) => {
        const existing = await tx.query<TokenProfileRow>(
          `${tokenProfileMetadataSelect()}
           where p.id = $1 and p.prism_user_id = $2 and p.slack_connection_id = $3 and p.status = 'active'
           limit 1`,
          [input.profileId, input.prismUserId, input.slackConnectionId]
        );
        const row = existing.rows[0];
        if (!row) return { kind: "not_found" as const };

        const newTokenId = randomUUID();
        await tx.query(
          `insert into prism_developer_tokens
            (id, token_profile_id, token_hash, hash_algorithm, pepper_id, expires_at, is_current)
           values ($1, $2, $3, $4, $5, $6, false)`,
          [newTokenId, row.id, input.verifier.tokenHash, input.verifier.algorithm, input.verifier.pepperId, row.expires_at]
        );

        await tx.query(
          `update prism_developer_tokens
           set revoked_at = case when $3::timestamptz is null then coalesce(revoked_at, $2) else revoked_at end,
              is_current = false,
              superseded_at = coalesce(superseded_at, $2),
              superseded_by_token_id = coalesce(superseded_by_token_id, $4),
              expires_at = case when $3::timestamptz is null then expires_at else $3 end,
              rotation_overlap_expires_at = $3
           where token_profile_id = $1 and id <> $4 and revoked_at is null`,
          [input.profileId, input.now, input.overlapExpiresAt, newTokenId]
        );

        await tx.query(
          `update prism_developer_tokens
           set is_current = true
           where id = $1`,
          [newTokenId]
        );

        if (input.audit) {
          await insertActivityAuditRecord(tx, {
            prismUserId: input.prismUserId,
            slackConnectionId: input.slackConnectionId,
            tokenProfileId: row.id,
            tokenProfileName: row.name,
            activityType: "token_profile_rotated",
            endpoint: input.audit.endpoint,
            actionCategory: input.overlap,
            status: "rotated",
            httpStatus: 200,
            requestId: input.audit.requestId,
            upstreamCalled: false
          });
        }

        return {
          kind: "rotated" as const,
          profile: {
            ...toTokenProfileMetadata(row),
            developerToken: {
              status: "active",
              createdAt: input.now,
              expiresAt: row.expires_at,
              lastUsedAt: null,
              revokedAt: null,
              overlapExpiresAt: input.overlapExpiresAt
            }
          }
        };
      });
    },
    async updateProfilePolicy(input) {
      return database.transaction(async (tx) => {
        const existing = await tx.query<TokenProfileRow>(
          `${tokenProfileMetadataSelect()}
           where p.id = $1 and p.prism_user_id = $2 and p.slack_connection_id = $3 and p.status = 'active'
           limit 1`,
          [input.profileId, input.prismUserId, input.slackConnectionId]
        );
        const row = existing.rows[0];
        if (!row) return { kind: "not_found" as const };

        await tx.query(
          `update token_profiles
           set preset = $2,
               capability_map = $3::jsonb,
               expires_at = $4,
               updated_at = $5
           where id = $1`,
          [input.profileId, input.preset, JSON.stringify(input.capabilityMap), input.expiresAt, input.now]
        );

        if (input.rotation) {
          const newTokenId = randomUUID();
          await tx.query(
            `insert into prism_developer_tokens
               (id, token_profile_id, token_hash, hash_algorithm, pepper_id, expires_at, is_current)
             values ($1, $2, $3, $4, $5, $6, false)`,
            [newTokenId, input.profileId, input.rotation.verifier.tokenHash, input.rotation.verifier.algorithm, input.rotation.verifier.pepperId, input.expiresAt]
          );

          await tx.query(
            `update prism_developer_tokens
             set revoked_at = coalesce(revoked_at, $2),
                 is_current = false,
                 superseded_at = coalesce(superseded_at, $2),
                 superseded_by_token_id = coalesce(superseded_by_token_id, $3),
                 rotation_overlap_expires_at = null
             where token_profile_id = $1 and id <> $3 and revoked_at is null`,
            [input.profileId, input.now, newTokenId]
          );
          await tx.query(
            `update prism_developer_tokens
             set is_current = true
             where id = $1`,
            [newTokenId]
          );
        } else {
          await tx.query(
            `update prism_developer_tokens
             set expires_at = $2
             where token_profile_id = $1 and revoked_at is null`,
            [input.profileId, input.expiresAt]
          );
        }

        if (input.audit) {
          await insertActivityAuditRecord(tx, {
            prismUserId: input.prismUserId,
            slackConnectionId: input.slackConnectionId,
            tokenProfileId: row.id,
            tokenProfileName: row.name,
            activityType: "token_profile_policy_updated",
            endpoint: input.audit.endpoint,
            actionCategory: input.preset,
            status: "updated",
            httpStatus: 200,
            requestId: input.audit.requestId,
            upstreamCalled: false
          });
        }

        const updated = await tx.query<TokenProfileRow>(
          `${tokenProfileMetadataSelect()}
           where p.id = $1 and p.prism_user_id = $2 and p.slack_connection_id = $3 and p.status = 'active'
           limit 1`,
          [input.profileId, input.prismUserId, input.slackConnectionId]
        );

        return { kind: "updated" as const, profile: toTokenProfileMetadata(updated.rows[0]!) };
      });
    },
    async resolveDeveloperToken({ tokenHash, now }) {
      const result = await database.query<DeveloperTokenResolutionRow>(
        `select
           t.id as developer_token_id,
           p.prism_user_id,
           p.id as token_profile_id,
           p.name as token_profile_name,
           p.slack_connection_id,
           t.expires_at as token_expires_at,
           t.revoked_at as token_revoked_at,
           t.last_used_at as token_last_used_at,
           t.rotation_overlap_expires_at as token_overlap_expires_at,
           t.is_current as token_is_current,
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
      if (!row) return null;
      if (isActiveResolvedToken(row, now)) {
        const lastUsed = await database.query<{ last_used_at: Date }>(
          `update prism_developer_tokens
           set last_used_at = $2
           where id = $1
             and revoked_at is null
             and (expires_at is null or expires_at > $2)
           returning last_used_at`,
          [row.developer_token_id, now]
        );
        if (lastUsed.rows[0]) {
          row.token_last_used_at = lastUsed.rows[0].last_used_at;
        }
      }
      return toResolvedDeveloperToken(row);
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
  status: "active" | "bootstrap" | "revoked";
  created_at: Date;
  updated_at: Date;
  developer_token_created_at?: Date | null;
  developer_token_expires_at?: Date | null;
  developer_token_last_used_at?: Date | null;
  developer_token_revoked_at?: Date | null;
  developer_token_is_current?: boolean | null;
  overlap_expires_at?: Date | null;
};

type DeveloperTokenResolutionRow = {
  developer_token_id: string;
  prism_user_id: string;
  token_profile_id: string;
  token_profile_name: string;
  slack_connection_id: string;
  token_expires_at: Date | null;
  token_revoked_at: Date | null;
  token_last_used_at: Date | null;
  token_overlap_expires_at: Date | null;
  token_is_current: boolean | null;
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
    status: row.status === "revoked" ? "revoked" : "active",
    developerToken: toDeveloperTokenMetadata(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toDeveloperTokenMetadata(row: TokenProfileRow): TokenProfileDeveloperTokenMetadata {
  const status = developerTokenStatus(row);
  return {
    status,
    createdAt: row.developer_token_created_at ?? null,
    expiresAt: row.developer_token_expires_at ?? null,
    lastUsedAt: row.developer_token_last_used_at ?? null,
    revokedAt: row.developer_token_revoked_at ?? null,
    overlapExpiresAt: row.overlap_expires_at ?? null
  };
}

function developerTokenStatus(row: TokenProfileRow): TokenProfileDeveloperTokenMetadata["status"] {
  if (!row.developer_token_created_at) return "missing";
  if (row.developer_token_revoked_at) return "revoked";
  if (row.developer_token_expires_at && row.developer_token_expires_at <= new Date()) return "expired";
  return "active";
}

function toResolvedDeveloperToken(row: DeveloperTokenResolutionRow): ResolvedDeveloperToken {
  return {
    developerTokenId: row.developer_token_id,
    prismUserId: row.prism_user_id,
    tokenProfileId: row.token_profile_id,
    tokenProfileName: row.token_profile_name,
    slackConnectionId: row.slack_connection_id,
    tokenExpiresAt: row.token_expires_at,
    tokenRevokedAt: row.token_revoked_at,
    tokenLastUsedAt: row.token_last_used_at,
    tokenOverlapExpiresAt: row.token_overlap_expires_at,
    tokenIsCurrent: row.token_is_current,
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

function isActiveResolvedToken(row: DeveloperTokenResolutionRow, now: Date): boolean {
  if (row.token_revoked_at || row.profile_status === "revoked" || row.profile_status === "bootstrap") return false;
  if (row.token_expires_at && row.token_expires_at <= now) return false;
  if (row.profile_expires_at && row.profile_expires_at <= now) return false;
  return true;
}

function isUniqueViolation(error: unknown): error is { code: "23505" } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

function tokenProfileMetadataSelect(): string {
  return `select
            p.id,
            p.prism_user_id,
            p.slack_connection_id,
            p.name,
            p.name_normalized,
            p.intended_use,
            p.preset,
            p.capability_map,
            p.expires_at,
            p.status,
            p.created_at,
            p.updated_at,
            t.created_at as developer_token_created_at,
            t.expires_at as developer_token_expires_at,
            t.last_used_at as developer_token_last_used_at,
            t.revoked_at as developer_token_revoked_at,
            t.is_current as developer_token_is_current,
            overlap.overlap_expires_at
          from token_profiles p
          left join lateral (
            select created_at, expires_at, last_used_at, revoked_at, is_current
            from prism_developer_tokens
            where token_profile_id = p.id
            order by is_current desc, created_at desc
            limit 1
          ) t on true
          left join lateral (
            select max(rotation_overlap_expires_at) as overlap_expires_at
            from prism_developer_tokens
            where token_profile_id = p.id
              and is_current = false
              and revoked_at is null
              and rotation_overlap_expires_at > now()
          ) overlap on true`;
}
