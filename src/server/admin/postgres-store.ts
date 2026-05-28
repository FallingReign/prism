import "server-only";

import type { Database } from "../db";
import { hashSecret } from "../slack/oauth-flow";
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
      }>(
        `select s.prism_user_id,
                c.authed_user_id as slack_user_id,
                nullif(c.authed_user_display_name, '') as slack_user_display_name,
                nullif(c.team_id, '') as team_id,
                nullif(c.team_name, '') as team_name,
                c.enterprise_id,
                nullif(c.enterprise_name, '') as enterprise_name
         from prism_sessions s
         join prism_users u on u.id = s.prism_user_id
         join slack_connections c on c.prism_user_id = u.id
         where s.session_token_hash = $1 and s.expires_at > $2
         order by c.updated_at desc
         limit 1`,
        [hashSecret(sessionToken), now]
      );
      const row = result.rows[0];
      return row ? toAdminSessionIdentity(row) : null;
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
}): AdminSessionIdentity {
  return {
    prismUserId: row.prism_user_id,
    slackUserId: row.slack_user_id,
    slackUserDisplayName: row.slack_user_display_name,
    teamId: row.team_id,
    teamName: row.team_name,
    enterpriseId: row.enterprise_id,
    enterpriseName: row.enterprise_name
  };
}
