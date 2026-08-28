import "server-only";

import type { Database } from "../db";
import { replaceOrganizationWorkspaceGrants } from "../slack/organization-workspace-grant-store";
import type { DirectoryConnection, DirectoryWorkspace, PlaytestDirectoryStore } from "./directory";

export function createPostgresPlaytestDirectoryStore(database: Database): PlaytestDirectoryStore {
  return {
    async listConnections(input) {
      const result = await database.query<{
        id: string; installation_scope: "workspace" | "organization"; team_id: string | null; team_name: string | null;
        enterprise_id: string | null; enterprise_name: string | null; grants_verified_at: Date | null;
      }>(
        `select c.id, c.installation_scope, c.team_id, c.team_name, c.enterprise_id, c.enterprise_name,
                max(g.last_verified_at) as grants_verified_at
         from slack_connections c
         left join slack_connection_workspace_grants g on g.slack_connection_id = c.id
         where c.prism_user_id = $1 and c.id = $2 and c.status = 'healthy'
           and exists (select 1 from slack_credentials sc where sc.connection_id = c.id and sc.kind = 'user')
         group by c.id
         order by c.updated_at desc`,
        [input.prismUserId, input.slackConnectionId]
      );
      return result.rows.map((row): DirectoryConnection => ({
        connectionId: row.id, installationScope: row.installation_scope, teamId: row.team_id, teamName: row.team_name,
        enterpriseId: row.enterprise_id, enterpriseName: row.enterprise_name, grantsVerifiedAt: row.grants_verified_at
      }));
    },

    async replaceOrganizationGrants(input) {
      await replaceOrganizationWorkspaceGrants(database, input);
    },

    async listWorkspaces(input) {
      const result = await database.query<{
        team_id: string; team_name: string | null; installation_scope: "workspace" | "organization";
        enterprise_name: string | null; last_verified_at: Date;
      }>(
        `select distinct on (g.team_id) g.team_id, g.team_name, c.installation_scope, c.enterprise_name, g.last_verified_at
         from slack_connection_workspace_grants g
         join slack_connections c on c.id = g.slack_connection_id
         where c.prism_user_id = $1 and c.id = $2 and c.status = 'healthy' and g.status = 'active'
           and exists (select 1 from slack_credentials sc where sc.connection_id = c.id and sc.kind = 'user')
         order by g.team_id, case when c.installation_scope = 'workspace' then 0 else 1 end, g.last_verified_at desc`,
        [input.prismUserId, input.slackConnectionId]
      );
      return result.rows.map((row): DirectoryWorkspace => ({
        teamId: row.team_id, teamName: row.team_name, installationScope: row.installation_scope,
        enterpriseName: row.enterprise_name, lastVerifiedAt: row.last_verified_at
      }));
    },

    async resolveConnection(input) {
      const result = await database.query<{ id: string }>(
        `select c.id
         from slack_connections c
         left join slack_connection_workspace_grants g
           on g.slack_connection_id = c.id and g.team_id = $3 and g.status = 'active'
         where c.prism_user_id = $1 and c.id = $2 and c.status = 'healthy'
           and ((c.installation_scope = 'workspace' and c.team_id = $3)
             or (c.installation_scope = 'organization' and g.team_id = $3))
           and exists (select 1 from slack_credentials sc where sc.connection_id = c.id and sc.kind = 'user')
         order by case when c.installation_scope = 'workspace' then 0 else 1 end, c.updated_at desc, c.id
         limit 1`,
        [input.prismUserId, input.slackConnectionId, input.teamId]
      );
      return result.rows[0] ? { connectionId: result.rows[0].id } : null;
    }
  };
}
