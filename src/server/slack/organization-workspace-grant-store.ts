import "server-only";

import { randomUUID } from "node:crypto";

import type { Database } from "../db";
import type { SlackOrganizationWorkspace } from "./organization-workspaces";

export async function replaceOrganizationWorkspaceGrants(
  database: Database,
  input: { connectionId: string; teams: SlackOrganizationWorkspace[]; verifiedAt: Date }
): Promise<void> {
  await database.transaction(async (tx) => {
    const locked = await tx.query<{ id: string }>(
      `select id from slack_connections where id = $1 and installation_scope = 'organization' and status = 'healthy' for update`,
      [input.connectionId]
    );
    if (!locked.rows[0]) throw new Error("organization-connection-unavailable");
    for (const team of input.teams) {
      await tx.query(
        `insert into slack_connection_workspace_grants
           (id, slack_connection_id, team_id, team_name, status, source, discovered_at, last_verified_at)
         values ($1, $2, $3, $4, 'active', 'auth_teams_list', $5, $5)
         on conflict (slack_connection_id, team_id)
         do update set team_name = excluded.team_name, status = 'active', source = 'auth_teams_list',
                       last_verified_at = excluded.last_verified_at, revoked_at = null, updated_at = now()`,
        [randomUUID(), input.connectionId, team.teamId, team.teamName, input.verifiedAt]
      );
    }
    await tx.query(
      `update slack_connection_workspace_grants
       set status = 'revoked', revoked_at = $2, last_verified_at = $2, updated_at = now()
       where slack_connection_id = $1 and status = 'active' and not (team_id = any($3::text[]))`,
      [input.connectionId, input.verifiedAt, input.teams.map((team) => team.teamId)]
    );
  });
}
