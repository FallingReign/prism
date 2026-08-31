import "server-only";

import { randomUUID } from "node:crypto";

import type { Database } from "../db";
import type { BindingRecord, BindingStore, OwnedRemoteCodexSession } from "./binding-service";

type OwnedSessionRow = {
  installation_id: string;
  codex_thread_id: string;
  safe_title: string;
  project_label: string;
  machine_label: string;
  status: string;
  prism_user_id: string;
  slack_connection_id: string;
  team_id: string;
  authed_user_id: string;
};

type BindingRow = {
  id: string;
  installation_id: string;
  codex_thread_id: string;
  team_id: string;
  channel_id: string | null;
  thread_ts: string | null;
  state: BindingRecord["state"];
};

export function createPostgresBindingStore(database: Database): BindingStore {
  return {
    async findSlackOwnedSession(input) {
      const result = await database.query<OwnedSessionRow>(ownedSessionSelect(
        `c.authed_user_id = $2 and c.app_id = $3 and i.id = $4 and s.codex_thread_id = $5`,
        "$1"
      ), [input.teamId, input.slackUserId, input.appId, input.installationId, input.threadId]);
      return result.rows[0] ? mapOwnedSession(result.rows[0]) : null;
    },
    async findRunnerOwnedSession(input) {
      const result = await database.query<OwnedSessionRow>(ownedSessionSelect(
        `i.prism_user_id = $1 and i.slack_connection_id = $2 and i.id = $3 and s.codex_thread_id = $4`,
        "i.default_team_id"
      ), [input.prismUserId, input.slackConnectionId, input.installationId, input.threadId]);
      return result.rows[0] ? mapOwnedSession(result.rows[0]) : null;
    },
    async reserve(session, now) {
      return database.transaction(async (transaction) => {
        await transaction.query(
          `update remote_codex_slack_bindings
              set state = 'failed', updated_at = $3
            where installation_id = $1 and codex_thread_id = $2 and state = 'creating'
              and updated_at < $4`,
          [session.installationId, session.threadId, now, new Date(now.getTime() - 2 * 60 * 1000)]
        );
        const existing = await readBinding(transaction, session.installationId, session.threadId, true);
        if (existing) return { binding: existing, created: false };
        const id = `rc_binding_${randomUUID().replace(/-/g, "")}`;
        await transaction.query(
          `insert into remote_codex_slack_bindings
             (id, prism_user_id, slack_connection_id, installation_id, codex_thread_id,
              team_id, state, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, 'creating', $7, $7)
           on conflict do nothing`,
          [id, session.prismUserId, session.connectionId, session.installationId, session.threadId, session.teamId, now]
        );
        const reserved = await readBinding(transaction, session.installationId, session.threadId, true);
        if (!reserved) throw new Error("binding_reservation_failed");
        return { binding: reserved, created: reserved.id === id };
      });
    },
    async activate(input) {
      const result = await database.query<BindingRow>(
        `update remote_codex_slack_bindings
            set channel_id = $2, thread_ts = $3, root_message_ts = $3,
                state = 'active', updated_at = $4
          where id = $1 and state = 'creating'
          returning id, installation_id, codex_thread_id, team_id, channel_id, thread_ts, state`,
        [input.bindingId, input.channelId, input.threadTs, input.now]
      );
      return result.rows[0] ? mapBinding(result.rows[0]) : null;
    },
    async fail(bindingId, now) {
      await database.query(
        `update remote_codex_slack_bindings set state = 'failed', updated_at = $2
          where id = $1 and state = 'creating'`,
        [bindingId, now]
      );
    }
  };
}

function ownedSessionSelect(where: string, targetTeam: string): string {
  return `select i.id as installation_id, s.codex_thread_id, s.safe_title, s.project_label, s.status,
                 i.machine_label, i.prism_user_id, i.slack_connection_id,
                 ${targetTeam}::text as team_id, c.authed_user_id
            from remote_codex_installations i
            join slack_connections c on c.id = i.slack_connection_id
            join remote_codex_sessions s on s.installation_id = i.id
            left join slack_connection_workspace_grants g
              on g.slack_connection_id = c.id and g.team_id = ${targetTeam} and g.status = 'active'
           where ${where}
             and i.revoked_at is null and i.state <> 'revoked'
             and c.status = 'healthy' and s.status <> 'unavailable'
             and exists (select 1 from slack_credentials cred where cred.connection_id = c.id and cred.kind = 'bot')
             and string_to_array(c.bot_scopes, ',') @> array['chat:write', 'im:write']::text[]
             and (
               (c.installation_scope = 'workspace' and c.team_id = ${targetTeam})
               or (c.installation_scope = 'organization' and g.team_id = ${targetTeam})
             )`;
}

async function readBinding(database: Database, installationId: string, threadId: string, lock: boolean): Promise<BindingRecord | null> {
  const result = await database.query<BindingRow>(
    `select id, installation_id, codex_thread_id, team_id, channel_id, thread_ts, state
       from remote_codex_slack_bindings
      where installation_id = $1 and codex_thread_id = $2 and state in ('creating', 'active')
      ${lock ? "for update" : ""}`,
    [installationId, threadId]
  );
  return result.rows[0] ? mapBinding(result.rows[0]) : null;
}

function mapOwnedSession(row: OwnedSessionRow): OwnedRemoteCodexSession {
  return {
    installationId: row.installation_id,
    threadId: row.codex_thread_id,
    title: row.safe_title,
    projectLabel: row.project_label,
    machineLabel: row.machine_label,
    status: safeStatus(row.status),
    prismUserId: row.prism_user_id,
    connectionId: row.slack_connection_id,
    teamId: row.team_id,
    slackUserId: row.authed_user_id
  };
}

function safeStatus(value: string): OwnedRemoteCodexSession["status"] {
  if (value === "active" || value === "attention") return value;
  return "ready";
}

function mapBinding(row: BindingRow): BindingRecord {
  return {
    id: row.id,
    installationId: row.installation_id,
    threadId: row.codex_thread_id,
    teamId: row.team_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    state: row.state
  };
}
