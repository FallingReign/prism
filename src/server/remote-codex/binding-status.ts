import "server-only";

import type { Database } from "../db";
import { buildRemoteCodexStatusBlocks, statusLabel, type OwnedRemoteCodexSession } from "./binding-service";

type BoundStatusRow = {
  binding_id: string;
  installation_id: string;
  codex_thread_id: string;
  safe_title: string;
  project_label: string;
  status: string;
  machine_label: string;
  prism_user_id: string;
  slack_connection_id: string;
  team_id: string;
  authed_user_id: string;
  channel_id: string;
  root_message_ts: string;
  workspace_authorized: boolean;
};

type SlackCaller = {
  call(input: {
    ownerKey: string;
    connectionId: string;
    prismUserId: string;
    slackUserId: string;
    slackTeamId: string;
    method: string;
    payload: Record<string, unknown>;
    activityType: "remote_codex_binding_status_updated";
    surface: "remote_codex_sync";
    objectType: "remote_codex_binding";
    objectId: string;
    requestId: string;
  }): Promise<{ kind: "ok"; body: unknown } | { kind: "unavailable"; error: string }>;
};

export async function publishBoundSessionStatuses({
  database,
  slack,
  installationId,
  requestId
}: {
  database: Database;
  slack: SlackCaller | (() => SlackCaller);
  installationId: string;
  requestId: string;
}): Promise<{ found: number; updated: number }> {
  let cursor = "";
  let found = 0;
  let updated = 0;
  let caller: SlackCaller | null = null;
  while (true) {
    const result = await database.query<BoundStatusRow>(
      `select b.id as binding_id, b.installation_id, b.codex_thread_id,
              s.safe_title, s.project_label, s.status, i.machine_label,
              i.prism_user_id, i.slack_connection_id, b.team_id, c.authed_user_id,
              b.channel_id, b.root_message_ts,
              (
                c.status = 'healthy'
                and exists (select 1 from slack_credentials cred where cred.connection_id = c.id and cred.kind = 'bot')
                and string_to_array(c.bot_scopes, ',') @> array['chat:write', 'im:write']::text[]
                and (
                  (c.installation_scope = 'workspace' and c.team_id = b.team_id)
                  or (c.installation_scope = 'organization' and g.team_id = b.team_id)
                )
              ) as workspace_authorized
         from remote_codex_slack_bindings b
         join remote_codex_sessions s
           on s.installation_id = b.installation_id and s.codex_thread_id = b.codex_thread_id
         join remote_codex_installations i on i.id = b.installation_id and i.revoked_at is null
         join slack_connections c
           on c.id = b.slack_connection_id and c.prism_user_id = b.prism_user_id
         left join slack_connection_workspace_grants g
           on g.slack_connection_id = c.id and g.team_id = b.team_id and g.status = 'active'
        where b.installation_id = $1 and b.state = 'active' and b.id > $2
          and b.channel_id is not null and b.root_message_ts is not null
        order by b.id
        limit 20`,
      [installationId, cursor]
    );
    if (result.rows.length === 0) break;
    found += result.rows.length;
    for (const row of result.rows) {
      cursor = row.binding_id;
      if (!row.workspace_authorized) continue;
      const session = mapSession(row);
      caller ??= typeof slack === "function" ? slack() : slack;
      const response = await caller.call({
        ownerKey: row.installation_id,
        connectionId: row.slack_connection_id,
        prismUserId: row.prism_user_id,
        slackUserId: row.authed_user_id,
        slackTeamId: row.team_id,
        method: "chat.update",
        payload: {
          channel: row.channel_id,
          ts: row.root_message_ts,
          text: `${session.title} is ${statusLabel(session.status)} in Prism Companion`,
          blocks: buildRemoteCodexStatusBlocks(session)
        },
        activityType: "remote_codex_binding_status_updated",
        surface: "remote_codex_sync",
        objectType: "remote_codex_binding",
        objectId: row.binding_id,
        requestId
      });
      if (response.kind === "ok") updated += 1;
    }
    if (result.rows.length < 20) break;
  }
  return { found, updated };
}

function mapSession(row: BoundStatusRow): OwnedRemoteCodexSession {
  return {
    installationId: row.installation_id,
    threadId: row.codex_thread_id,
    title: row.safe_title,
    projectLabel: row.project_label,
    status: row.status === "active" || row.status === "attention" || row.status === "unavailable" ? row.status : "ready",
    machineLabel: row.machine_label,
    prismUserId: row.prism_user_id,
    connectionId: row.slack_connection_id,
    teamId: row.team_id,
    slackUserId: row.authed_user_id
  };
}
