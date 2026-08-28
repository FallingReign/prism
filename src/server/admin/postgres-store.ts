import "server-only";

import type { Database } from "../db";
import { hashSecret } from "../slack/oauth-flow";
import { parseSlackWorkspaceGrantDisplay } from "../slack/workspace-grant-display";
import type { AdminIdentityStore, AdminSessionIdentity } from "./authorization";

export function createPostgresAdminIdentityStore(database: Database): AdminIdentityStore {
  return {
    async getCurrentIdentity({ sessionToken, now }) {
      const result = await database.query<{
        prism_user_id: string;
        slack_user_id: string;
        slack_user_display_name: string | null;
        team_id: string | null;
        team_name: string | null;
        enterprise_id: string | null;
        enterprise_name: string | null;
        installation_scope: "workspace" | "organization";
        workspace_grants: unknown;
      }>(
        `select s.prism_user_id,
                c.authed_user_id as slack_user_id,
                nullif(c.authed_user_display_name, '') as slack_user_display_name,
                nullif(c.team_id, '') as team_id,
                nullif(c.team_name, '') as team_name,
                c.enterprise_id,
                nullif(c.enterprise_name, '') as enterprise_name,
                c.installation_scope,
                coalesce((
                  select jsonb_agg(
                    jsonb_build_object('team_id', g.team_id, 'team_name', nullif(g.team_name, ''))
                    order by lower(coalesce(g.team_name, g.team_id)), g.team_id
                  )
                  from slack_connection_workspace_grants g
                  where g.slack_connection_id = c.id and g.status = 'active'
                ), '[]'::jsonb) as workspace_grants
         from prism_sessions s
         join prism_users u on u.id = s.prism_user_id
         join slack_connections c
           on c.id = s.slack_connection_id and c.prism_user_id = u.id
         where s.session_token_hash = $1 and s.expires_at > $2
         limit 1`,
        [hashSecret(sessionToken), now]
      );
      const row = result.rows[0];
      return row ? toAdminSessionIdentity(row) : null;
    },
    async hasActiveGlobalAdmin({ prismUserId }) {
      const result = await database.query<{ authorized: boolean }>(
        `select exists (
           select 1 from prism_configuration_admins
           where prism_user_id = $1
             and role = 'global_configuration_admin'
             and revoked_at is null
         ) as authorized`,
        [prismUserId]
      );
      return result.rows[0]?.authorized === true;
    }
  };
}

function toAdminSessionIdentity(row: {
  prism_user_id: string;
  slack_user_id: string;
  slack_user_display_name: string | null;
  team_id: string | null;
  team_name: string | null;
  enterprise_id: string | null;
  enterprise_name: string | null;
  installation_scope?: "workspace" | "organization";
  workspace_grants?: unknown;
}): AdminSessionIdentity {
  return {
    prismUserId: row.prism_user_id,
    slackUserId: row.slack_user_id,
    slackUserDisplayName: row.slack_user_display_name,
    teamId: row.team_id,
    teamName: row.team_name,
    enterpriseId: row.enterprise_id,
    enterpriseName: row.enterprise_name,
    installationScope: row.installation_scope ?? (row.team_id ? "workspace" : "organization"),
    workspaceGrants: parseSlackWorkspaceGrantDisplay(row.workspace_grants)
  };
}
