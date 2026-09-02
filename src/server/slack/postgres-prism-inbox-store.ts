import "server-only";

import { randomUUID } from "node:crypto";

import type { Database } from "../db";
import { hashSecret } from "./oauth-flow";
import type { PrismInboxDelivery, PrismInboxStore } from "./prism-inbox";

const CLEANUP_BATCH_SIZE = 200;

export function createPostgresPrismInboxStore(database: Database): PrismInboxStore {
  return {
    async createRoute(input) {
      const id = input.id || randomUUID();
      await cleanup(database, input.now);
      const result = await database.query<{ id: string }>(
        `insert into prism_slack_inbound_routes
           (id, route_key_hash, token_profile_id, slack_connection_id, workspace_id,
            channel_id, slack_user_id, envelope_type, action_type, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         returning id`,
        [
          id,
          hashSecret(input.routeKey),
          input.tokenProfileId,
          input.slackConnectionId,
          input.workspaceId,
          input.channelId,
          input.slackUserId,
          input.envelopeType,
          input.actionType,
          input.expiresAt,
          input.now
        ]
      );
      return { id: result.rows[0]!.id };
    },

    async closeRoute(input) {
      const result = await database.query(
        `update prism_slack_inbound_routes
         set status = 'closed', closed_at = coalesce(closed_at, $3), updated_at = $3
         where id = $1 and token_profile_id = $2 and status = 'active'`,
        [input.routeId, input.tokenProfileId, input.now]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async deliverBlockAction(input) {
      return database.transaction(async (tx) => {
        const route = await tx.query<{ id: string; token_profile_id: string }>(
          `select r.id, r.token_profile_id
           from prism_slack_inbound_routes r
           join token_profiles p on p.id = r.token_profile_id and p.status = 'active'
           join slack_connections c on c.id = r.slack_connection_id and c.status = 'healthy'
           where r.route_key_hash = $1
             and r.status = 'active' and r.expires_at > $2
             and r.workspace_id = $3 and r.channel_id = $4 and r.slack_user_id = $5
             and r.envelope_type = 'block_actions' and r.action_type = $6
             and (
               (c.installation_scope = 'workspace' and c.team_id = r.workspace_id)
               or (
                 c.installation_scope = 'organization'
                 and exists (
                   select 1 from slack_connection_workspace_grants g
                   where g.slack_connection_id = c.id
                     and g.team_id = r.workspace_id and g.status = 'active'
                 )
               )
             )
             and coalesce((p.capability_map #>> '{inbound,blockActions}')::boolean, false) = true
             and exists (
               select 1 from prism_developer_tokens t
               where t.token_profile_id = p.id and t.is_current = true and t.revoked_at is null
                 and (t.expires_at is null or t.expires_at > $2)
             )
           limit 1
           for share of r`,
          [hashSecret(input.routeKey), input.receivedAt, input.workspaceId, input.channelId, input.slackUserId, input.actionType]
        );
        const matched = route.rows[0];
        if (!matched) return { kind: "unmatched" as const };

        const inserted = await tx.query<{ id: string }>(
          `insert into prism_slack_inbound_deliveries
             (id, route_id, token_profile_id, envelope_id, payload_type, api_app_id,
              workspace_id, enterprise_id, slack_user_id, channel_id, message_ts,
              block_id, action_id, action_type, selected_option_value, received_at,
              expires_at, created_at, updated_at)
           values ($1, $2, $3, $4, 'block_actions', $5, $6, $7, $8, $9, $10,
                   $11, $12, $13, $14, $15, $16, $15, $15)
           on conflict (envelope_id, route_id) do nothing
           returning id`,
          [
            randomUUID(), matched.id, matched.token_profile_id, input.envelopeId, input.apiAppId,
            input.workspaceId, input.enterpriseId, input.slackUserId, input.channelId,
            input.messageTs, input.blockId, input.actionId, input.actionType,
            input.selectedOptionValue, input.receivedAt, input.expiresAt
          ]
        );
        return { kind: inserted.rowCount ? "delivered" as const : "duplicate" as const };
      });
    },

    async leaseDeliveries(input) {
      await cleanup(database, input.now);
      const leaseId = randomUUID();
      const result = await database.query<DeliveryRow>(
        `with candidates as (
           select d.id from prism_slack_inbound_deliveries d
           join prism_slack_inbound_routes r on r.id = d.route_id
           join token_profiles p on p.id = d.token_profile_id and p.status = 'active'
           join slack_connections c on c.id = r.slack_connection_id and c.status = 'healthy'
           where d.token_profile_id = $1
             and d.acknowledged_at is null and d.expires_at > $2
             and (d.lease_expires_at is null or d.lease_expires_at <= $2)
             and coalesce((p.capability_map #>> '{inbound,blockActions}')::boolean, false) = true
             and (
               (c.installation_scope = 'workspace' and c.team_id = d.workspace_id)
               or (
                 c.installation_scope = 'organization'
                 and exists (
                   select 1 from slack_connection_workspace_grants g
                   where g.slack_connection_id = c.id
                     and g.team_id = d.workspace_id and g.status = 'active'
                 )
               )
             )
           order by d.received_at, d.id
           limit $3
           for update skip locked
         )
         update prism_slack_inbound_deliveries d
         set lease_id = $4, lease_expires_at = $5, updated_at = $2
         from candidates
         where d.id = candidates.id
         returning d.id, d.route_id, d.envelope_id, d.payload_type, d.workspace_id,
                   d.channel_id, d.slack_user_id, d.message_ts, d.block_id, d.action_id,
                   d.action_type, d.selected_option_value, d.received_at, d.expires_at,
                   d.lease_id`,
        [input.tokenProfileId, input.now, input.limit, leaseId, input.leaseExpiresAt]
      );
      return result.rows.map(toDelivery);
    },

    async acknowledgeDelivery(input) {
      const result = await database.query<{ acknowledged_at: Date | null; lease_id: string | null }>(
        `select acknowledged_at, lease_id
         from prism_slack_inbound_deliveries
         where id = $1 and token_profile_id = $2
         limit 1`,
        [input.deliveryId, input.tokenProfileId]
      );
      const delivery = result.rows[0];
      if (!delivery) return "not_found";
      if (delivery.acknowledged_at) return "acknowledged";
      if (delivery.lease_id !== input.leaseId) return "lease_mismatch";

      await database.query(
        `update prism_slack_inbound_deliveries
         set acknowledged_at = $4, payload_removed_at = $4,
             selected_option_value = null, block_id = null, action_id = null,
             lease_id = null, lease_expires_at = null, updated_at = $4
         where id = $1 and token_profile_id = $2 and lease_id = $3 and acknowledged_at is null`,
        [input.deliveryId, input.tokenProfileId, input.leaseId, input.now]
      );
      return "acknowledged";
    }
  };
}

type DeliveryRow = {
  id: string;
  route_id: string;
  envelope_id: string;
  payload_type: "block_actions";
  workspace_id: string;
  channel_id: string;
  slack_user_id: string;
  message_ts: string;
  block_id: string | null;
  action_id: string;
  action_type: "static_select";
  selected_option_value: string;
  received_at: Date;
  expires_at: Date;
  lease_id: string;
};

function toDelivery(row: DeliveryRow): PrismInboxDelivery {
  return {
    id: row.id,
    routeId: row.route_id,
    envelopeId: row.envelope_id,
    payloadType: row.payload_type,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    slackUserId: row.slack_user_id,
    messageTs: row.message_ts,
    blockId: row.block_id,
    actionId: row.action_id,
    actionType: row.action_type,
    selectedOptionValue: row.selected_option_value,
    receivedAt: row.received_at,
    expiresAt: row.expires_at,
    leaseId: row.lease_id
  };
}

async function cleanup(database: Database, now: Date): Promise<void> {
  await database.query(
    `update prism_slack_inbound_routes
     set status = 'closed', closed_at = coalesce(closed_at, $1), updated_at = $1
     where id in (
       select id from prism_slack_inbound_routes
       where status = 'active' and expires_at <= $1
       order by expires_at limit $2
     )`,
    [now, CLEANUP_BATCH_SIZE]
  );
  await database.query(
    `delete from prism_slack_inbound_deliveries
     where id in (
       select id from prism_slack_inbound_deliveries
       where expires_at <= $1 or (acknowledged_at is not null and acknowledged_at < $1 - interval '1 day')
       order by coalesce(acknowledged_at, expires_at) limit $2
     )`,
    [now, CLEANUP_BATCH_SIZE]
  );
  await database.query(
    `delete from prism_slack_inbound_routes r
     where r.id in (
       select candidate.id from prism_slack_inbound_routes candidate
       where candidate.status = 'closed'
         and candidate.closed_at < $1 - interval '1 day'
         and not exists (
           select 1 from prism_slack_inbound_deliveries d where d.route_id = candidate.id
         )
       order by candidate.closed_at limit $2
     )`,
    [now, CLEANUP_BATCH_SIZE]
  );
}
