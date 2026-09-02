import "server-only";

import type { Database } from "../db";
import { ingestSlackSocketEnvelope, type PrismInboxStore } from "./prism-inbox";

export type SlackSocketEvent = {
  type: string;
  envelope_id?: string;
  body?: unknown;
  ack: (response?: unknown) => Promise<void>;
};

export async function handleSlackSocketEvent({
  event,
  store,
  apiAppId,
  now = new Date()
}: {
  event: SlackSocketEvent;
  store: PrismInboxStore;
  apiAppId: string;
  now?: Date;
}): Promise<"delivered" | "duplicate" | "discarded"> {
  if (event.type !== "interactive" || !event.envelope_id) {
    await event.ack();
    return "discarded";
  }
  const result = await ingestSlackSocketEnvelope({
    store,
    envelope: { envelope_id: event.envelope_id, type: event.type, payload: event.body },
    apiAppId,
    now
  });
  await event.ack();
  return result.kind;
}

export type SocketWorkerHealthStatus = "disabled" | "starting" | "connected" | "disconnected" | "error" | "standby";

export async function updateSocketWorkerHealth(database: Database, input: {
  workerKey?: string;
  status: SocketWorkerHealthStatus;
  connectedAt?: Date | null;
  lastErrorClass?: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await database.query(
    `insert into prism_slack_socket_worker_health
       (worker_key, status, connected_at, heartbeat_at, last_error_class, updated_at)
     values ($1, $2, $3, $4, $5, $4)
     on conflict (worker_key) do update
     set status = excluded.status,
         connected_at = case when excluded.status = 'connected' then coalesce(prism_slack_socket_worker_health.connected_at, excluded.connected_at) else prism_slack_socket_worker_health.connected_at end,
         heartbeat_at = excluded.heartbeat_at,
         last_error_class = excluded.last_error_class,
         updated_at = excluded.updated_at`,
    [input.workerKey ?? "primary", input.status, input.connectedAt ?? null, now, input.lastErrorClass ?? null]
  );
}

export async function readSocketWorkerHealth(database: Database, now = new Date()): Promise<{ status: SocketWorkerHealthStatus; heartbeatAt: string | null; lastErrorClass: string | null }> {
  const result = await database.query<{ status: SocketWorkerHealthStatus; heartbeat_at: Date; last_error_class: string | null }>(
    `select status, heartbeat_at, last_error_class
     from prism_slack_socket_worker_health where worker_key = 'primary' limit 1`
  );
  const row = result.rows[0];
  if (!row) return { status: "disabled", heartbeatAt: null, lastErrorClass: null };
  if (row.status === "connected" && now.getTime() - row.heartbeat_at.getTime() > 45_000) {
    return { status: "disconnected", heartbeatAt: row.heartbeat_at.toISOString(), lastErrorClass: "heartbeat_stale" };
  }
  return { status: row.status, heartbeatAt: row.heartbeat_at.toISOString(), lastErrorClass: row.last_error_class };
}
