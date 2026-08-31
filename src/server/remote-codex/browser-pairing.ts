import "server-only";

import type { Database } from "../db";
import { hashSecret } from "./pairing-service";

type ApprovalRow = {
  pairing_id: string;
  machine_label: string;
  companion_version: string;
  verification_phrase: string;
  expires_at: Date | string;
  connection_id: string;
  installation_scope: "workspace" | "organization";
  target_team_id: string;
  target_team_name: string | null;
  enterprise_id: string | null;
  enterprise_name: string | null;
  slack_user_id: string;
  slack_user_display_name: string | null;
};

export type PairingApprovalContext =
  | { kind: "unauthenticated" | "unavailable" }
  | {
      kind: "ready";
      pairingId: string;
      machineLabel: string;
      companionVersion: string;
      verificationPhrase: string;
      expiresAt: string;
      identity: {
        connectionId: string;
        installationLabel: string;
        slackUserId: string;
        slackUserLabel: string;
      };
      workspaces: Array<{
        teamId: string;
        label: string;
      }>;
    };

export async function getPairingApprovalContext(
  database: Database,
  {
    pairingId,
    sessionToken,
    now = new Date()
  }: { pairingId: string; sessionToken: string | undefined; now?: Date }
): Promise<PairingApprovalContext> {
  if (!sessionToken) return { kind: "unauthenticated" };
  const result = await database.query<ApprovalRow>(
    `select p.id as pairing_id, p.machine_label, p.companion_version, p.verification_phrase, p.expires_at,
            c.id as connection_id, c.installation_scope,
            target.team_id as target_team_id, target.team_name as target_team_name,
            c.enterprise_id, nullif(c.enterprise_name, '') as enterprise_name,
            c.authed_user_id as slack_user_id,
            nullif(c.authed_user_display_name, '') as slack_user_display_name
       from prism_sessions s
       join slack_connections c
         on c.id = s.slack_connection_id and c.prism_user_id = s.prism_user_id and c.status = 'healthy'
       join lateral (
         select c.team_id, nullif(c.team_name, '') as team_name
          where c.installation_scope = 'workspace' and c.team_id is not null
         union all
         select g.team_id, nullif(g.team_name, '') as team_name
           from slack_connection_workspace_grants g
          where c.installation_scope = 'organization'
            and g.slack_connection_id = c.id and g.status = 'active'
       ) target on true
       join remote_codex_pairing_requests p on p.id = $2 and p.status = 'pending' and p.expires_at > $3
      where s.session_token_hash = $1 and s.expires_at > $3
        and exists (select 1 from slack_credentials cred where cred.connection_id = c.id and cred.kind = 'bot')
        and string_to_array(c.bot_scopes, ',') @> array['chat:write', 'im:write']::text[]
      order by lower(coalesce(target.team_name, target.team_id)), target.team_id`,
    [hashSecret(sessionToken), pairingId, now]
  );
  if (!result.rows[0]) return { kind: "unavailable" };
  const first = result.rows[0];
  return {
    kind: "ready",
    pairingId: first.pairing_id,
    machineLabel: safeLabel(first.machine_label, "Computer"),
    companionVersion: safeLabel(first.companion_version, "Unknown"),
    verificationPhrase: safeLabel(first.verification_phrase, "Unavailable"),
    expiresAt: new Date(first.expires_at).toISOString(),
    identity: {
      connectionId: first.connection_id,
      installationLabel: safeLabel(
        first.enterprise_name ?? first.target_team_name ?? first.target_team_id,
        first.target_team_id
      ),
      slackUserId: first.slack_user_id,
      slackUserLabel: safeLabel(first.slack_user_display_name ?? first.slack_user_id, first.slack_user_id)
    },
    workspaces: result.rows.map((row) => ({
      teamId: row.target_team_id,
      label: safeLabel(row.target_team_name ?? row.target_team_id, row.target_team_id)
    }))
  };
}

function safeLabel(value: string, fallback: string): string {
  const clean = value
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 80);
  return clean || fallback;
}
