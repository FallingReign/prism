import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { Database } from "../db";
import type { DeveloperTokenVerifier } from "./developer-token";
import type { CapabilityMap, TokenProfilePreset } from "./presets";

export type ApplicationProfileResult = {
  profileId: string;
  profileName: string;
  created: boolean;
  rebound: boolean;
  installationScope: "workspace" | "organization";
  slackUserId: string;
  slackTeamId: string | null;
  slackEnterpriseId: string | null;
};

export async function issueApplicationProfileToken(
  database: Database,
  input: {
    prismUserId: string;
    slackConnectionId: string;
    clientId: string;
    profileName: string;
    intendedUse: string;
    preset: TokenProfilePreset;
    capabilityMap: CapabilityMap;
    expiresAt: Date | null;
    verifier: DeveloperTokenVerifier;
    rotation: "immediate" | "until_expiry";
    now: Date;
  }
): Promise<ApplicationProfileResult | null> {
  await database.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `prism:application-profile:${input.clientId}:${input.prismUserId}`
  ]);
  const eligible = await database.query<{
    id: string;
    installation_scope: "workspace" | "organization";
    authed_user_id: string;
    team_id: string | null;
    enterprise_id: string | null;
  }>(
    `select c.id, c.installation_scope, c.authed_user_id, c.team_id, c.enterprise_id
     from slack_connections c
     where c.id = $1 and c.prism_user_id = $2 and c.status = 'healthy'
       and exists (
         select 1 from slack_credentials sc
         where sc.connection_id = c.id and sc.kind = 'user'
       )
     for update`,
    [input.slackConnectionId, input.prismUserId]
  );
  const connection = eligible.rows[0];
  if (!connection) return null;

  let profile = await database.query<{ id: string; name: string; slack_connection_id: string }>(
    `select id, name, slack_connection_id from token_profiles
     where prism_user_id = $1 and client_id = $2 and status = 'active'
     for update`,
    [input.prismUserId, input.clientId]
  );
  const created = !profile.rows[0];
  const rebound = Boolean(profile.rows[0] && profile.rows[0].slack_connection_id !== input.slackConnectionId);
  if (!profile.rows[0]) {
    profile = await database.query<{ id: string; name: string; slack_connection_id: string }>(
      `insert into token_profiles
         (id, prism_user_id, slack_connection_id, client_id, name,
          name_normalized, intended_use, preset, capability_map,
          expires_at, status, policy_effective_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'active', $11)
       returning id, name, slack_connection_id`,
      [
        randomUUID(), input.prismUserId, input.slackConnectionId, input.clientId,
        input.profileName, normalizedApplicationProfileName(input.clientId),
        input.intendedUse, input.preset, JSON.stringify(input.capabilityMap),
        input.expiresAt, input.now
      ]
    );
  } else if (rebound) {
    profile = await database.query<{ id: string; name: string; slack_connection_id: string }>(
      `update token_profiles
       set slack_connection_id = $2, updated_at = $3
       where id = $1 and prism_user_id = $4 and client_id = $5 and status = 'active'
       returning id, name, slack_connection_id`,
      [
        profile.rows[0].id, input.slackConnectionId, input.now,
        input.prismUserId, input.clientId
      ]
    );
  }
  const row = profile.rows[0];
  if (!row) return null;

  await database.query(
    `update token_profiles
     set name = $2,
         intended_use = $3,
         preset = $4,
         capability_map = $5::jsonb,
         expires_at = $6,
         policy_effective_at = $7,
         updated_at = $7
     where id = $1 and prism_user_id = $8 and client_id = $9 and status = 'active'`,
    [
      row.id, input.profileName, input.intendedUse, input.preset,
      JSON.stringify(input.capabilityMap), input.expiresAt, input.now,
      input.prismUserId, input.clientId
    ]
  );

  // The partial unique index permits only one current token per profile. An
  // expired token can still carry is_current=true, so demote it before the new
  // token is inserted and promoted.
  await database.query(
    `update prism_developer_tokens
     set revoked_at = coalesce(revoked_at, $2),
         is_current = false,
         rotation_overlap_expires_at = null
     where token_profile_id = $1 and is_current = true
       and expires_at is not null and expires_at <= $2`,
    [row.id, input.now]
  );

  const newTokenId = randomUUID();
  await database.query(
    `insert into prism_developer_tokens
       (id, token_profile_id, token_hash, hash_algorithm, pepper_id,
        expires_at, is_current)
     values ($1, $2, $3, $4, $5, $6, false)`,
    [
      newTokenId, row.id, input.verifier.tokenHash, input.verifier.algorithm,
      input.verifier.pepperId, input.expiresAt
    ]
  );

  if (input.rotation === "immediate" || rebound) {
    await database.query(
      `update prism_developer_tokens
       set revoked_at = coalesce(revoked_at, $2),
           is_current = false,
           superseded_at = coalesce(superseded_at, $2),
           superseded_by_token_id = coalesce(superseded_by_token_id, $3),
           rotation_overlap_expires_at = null
       where token_profile_id = $1 and id <> $3 and revoked_at is null`,
      [row.id, input.now, newTokenId]
    );
  } else {
    await database.query(
      `update prism_developer_tokens
       set is_current = false,
           superseded_at = coalesce(superseded_at, $2),
           superseded_by_token_id = coalesce(superseded_by_token_id, $3),
           expires_at = least(coalesce(expires_at, $4), $4),
           rotation_overlap_expires_at = least(coalesce(expires_at, $4), $4)
       where token_profile_id = $1 and id <> $3 and is_current = true
         and revoked_at is null and (expires_at is null or expires_at > $2)`,
      [row.id, input.now, newTokenId, input.expiresAt]
    );
  }
  await database.query(
    "update prism_developer_tokens set is_current = true where id = $1",
    [newTokenId]
  );

  return {
    profileId: row.id,
    profileName: input.profileName,
    created,
    rebound,
    installationScope: connection.installation_scope ?? "workspace",
    slackUserId: connection.authed_user_id,
    slackTeamId: connection.team_id ?? null,
    slackEnterpriseId: connection.enterprise_id ?? null
  };
}

function normalizedApplicationProfileName(clientId: string): string {
  const hash = createHash("sha256").update(clientId).digest("hex").slice(0, 16);
  return `application_${hash}`;
}
