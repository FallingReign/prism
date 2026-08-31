import "server-only";

import type { Database } from "../db";
import type { RemoteCodexSessionStatus } from "./session-service";

type SlackCatalogRow = {
  publisher_connection_id: string;
  publisher_prism_user_id: string;
  installation_id: string | null;
  machine_label: string | null;
  codex_thread_id: string | null;
  safe_title: string | null;
  project_label: string | null;
  status: string | null;
  last_activity_at: Date | string | null;
};

export type SlackCatalogSession = {
  installationId: string;
  threadId: string;
  title: string;
  projectLabel: string;
  status: Exclude<RemoteCodexSessionStatus, "unavailable">;
  lastActivity: string;
  machineLabel: string;
};

export async function getOwnerSlackCatalog(
  database: Database,
  { teamId, slackUserId, appId, limit = 10 }: { teamId: string; slackUserId: string; appId: string; limit?: number }
): Promise<{ connectionId: string | null; sessions: SlackCatalogSession[] }> {
  const boundedLimit = Math.min(Math.max(limit, 1), 20);
  const result = await database.query<SlackCatalogRow>(
    `with eligible_connections as (
       select c.*
         from slack_connections c
         left join slack_connection_workspace_grants g
           on g.slack_connection_id = c.id and g.team_id = $1 and g.status = 'active'
        where c.authed_user_id = $2 and c.app_id = $3 and c.status = 'healthy'
          and exists (select 1 from slack_credentials cred where cred.connection_id = c.id and cred.kind = 'bot')
          and string_to_array(c.bot_scopes, ',') @> array['chat:write', 'im:write']::text[]
          and (
            (c.installation_scope = 'workspace' and c.team_id = $1)
            or (c.installation_scope = 'organization' and g.team_id = $1)
          )
     ), publisher as (
       select id, prism_user_id from eligible_connections
        order by case when installation_scope = 'workspace' then 0 else 1 end,
                 updated_at desc, id
        limit 1
     )
     select p.id as publisher_connection_id, p.prism_user_id as publisher_prism_user_id,
            i.id as installation_id, i.machine_label,
            s.codex_thread_id, s.safe_title, s.project_label, s.status, s.last_activity_at
       from publisher p
       left join eligible_connections c on true
       left join remote_codex_installations i on c.id = i.slack_connection_id and i.revoked_at is null
       left join remote_codex_sessions s on s.installation_id = i.id and s.status <> 'unavailable'
      order by s.last_activity_at desc nulls last
       limit $4`,
    [teamId, slackUserId, appId, boundedLimit]
  );
  return {
    connectionId: result.rows[0]?.publisher_connection_id ?? null,
    sessions: result.rows.filter(isSessionRow).map(mapSession)
  };
}

export async function getOwnerSlackContext(
  database: Database,
  input: { teamId: string; slackUserId: string; appId: string; limit?: number }
): Promise<{ connectionId: string | null; prismUserId: string | null; sessions: SlackCatalogSession[] }> {
  const catalog = await getOwnerSlackCatalog(database, input);
  if (!catalog.connectionId) return { ...catalog, prismUserId: null };
  const owner = await database.query<{ prism_user_id: string }>(
    `select prism_user_id from slack_connections where id = $1`,
    [catalog.connectionId]
  );
  return { ...catalog, prismUserId: owner.rows[0]?.prism_user_id ?? null };
}

function isSessionRow(row: SlackCatalogRow): row is SlackCatalogRow & {
  installation_id: string;
  machine_label: string;
  codex_thread_id: string;
  safe_title: string;
  project_label: string;
  status: string;
  last_activity_at: Date | string;
} {
  return Boolean(row.installation_id && row.machine_label && row.codex_thread_id && row.safe_title && row.project_label && row.status && row.last_activity_at);
}

function mapSession(row: SlackCatalogRow & { installation_id: string; machine_label: string; codex_thread_id: string; safe_title: string; project_label: string; status: string; last_activity_at: Date | string }): SlackCatalogSession {
  return {
    installationId: row.installation_id,
    threadId: row.codex_thread_id,
    title: row.safe_title,
    projectLabel: row.project_label,
    status: safeStatus(row.status),
    lastActivity: new Date(row.last_activity_at).toISOString(),
    machineLabel: row.machine_label
  };
}

function safeStatus(value: string): SlackCatalogSession["status"] {
  if (value === "active" || value === "attention") return value;
  return "ready";
}
