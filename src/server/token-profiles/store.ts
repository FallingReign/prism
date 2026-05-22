import "server-only";

import { randomUUID } from "node:crypto";

import type { Database } from "../db";
import { hashSecret } from "../slack/oauth-flow";
import type { CapabilityMap, TokenProfilePreset } from "./presets";
import type { TokenProfileMetadata, TokenProfileStore } from "./service";

export function createPostgresTokenProfileStore(database: Database): TokenProfileStore {
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
          return { kind: "created" as const, profile: toTokenProfileMetadata(row) };
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { kind: "duplicate_name" };
        throw error;
      }
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

function isUniqueViolation(error: unknown): error is { code: "23505" } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}
