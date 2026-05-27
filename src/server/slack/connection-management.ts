import "server-only";

import { insertActivityAuditRecord } from "../audit/postgres-store";
import type { Database } from "../db";
import { hashSecret } from "./oauth-flow";

export type RemoveSlackConnectionResult =
  | { kind: "removed"; connectionId: string }
  | { kind: "unauthenticated" | "not_linked" | "not_found" };

export type SlackConnectionManagementStore = {
  removeCurrentConnection(input: { sessionToken: string; audit?: { endpoint: string; requestId: string }; now: Date }): Promise<RemoveSlackConnectionResult>;
};

type CurrentConnectionRow = {
  id: string;
  prism_user_id: string;
  authed_user_id: string;
  team_id: string | null;
  enterprise_id: string | null;
};

export async function removeSlackConnection({
  store,
  sessionToken,
  audit,
  now = new Date()
}: {
  store: SlackConnectionManagementStore;
  sessionToken: string | undefined;
  audit?: { endpoint: string; requestId: string };
  now?: Date;
}): Promise<RemoveSlackConnectionResult> {
  if (!sessionToken) return { kind: "unauthenticated" };
  return store.removeCurrentConnection({ sessionToken, audit, now });
}

export function createPostgresSlackConnectionManagementStore(database: Database): SlackConnectionManagementStore {
  return {
    async removeCurrentConnection(input) {
      return database.transaction(async (tx) => {
        const current = await tx.query<CurrentConnectionRow>(
          `select c.id, c.prism_user_id, c.authed_user_id, nullif(c.team_id, '') as team_id, c.enterprise_id
           from prism_sessions s
           join slack_connections c on c.prism_user_id = s.prism_user_id
           where s.session_token_hash = $1 and s.expires_at > $2
           order by c.updated_at desc
           limit 1
           for update of c`,
          [hashSecret(input.sessionToken), input.now]
        );
        const row = current.rows[0];
        if (!row) return { kind: "not_linked" as const };

        if (input.audit) {
          await insertActivityAuditRecord(tx, {
            prismUserId: row.prism_user_id,
            slackConnectionId: row.id,
            slackUserId: row.authed_user_id,
            slackTeamId: row.team_id,
            slackEnterpriseId: row.enterprise_id,
            activityType: "slack_connection_removed",
            endpoint: input.audit.endpoint,
            objectType: "slack_connection",
            objectId: row.id,
            status: "deleted",
            httpStatus: 200,
            requestId: input.audit.requestId,
            upstreamCalled: false,
            occurredAt: input.now
          });
        }

        const deleted = await tx.query(
          `delete from slack_connections
           where id = $1 and prism_user_id = $2`,
          [row.id, row.prism_user_id]
        );
        if (!deleted.rowCount) return { kind: "not_found" as const };
        return { kind: "removed" as const, connectionId: row.id };
      });
    }
  };
}
