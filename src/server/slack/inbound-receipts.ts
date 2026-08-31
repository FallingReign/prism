import "server-only";

import type { Database } from "../db";

export type SlackInboundReceiptStore = {
  claim(input: {
    teamId: string;
    callbackId: string;
    callbackType: "event" | "interaction";
    retryNumber: number | null;
    now: Date;
  }): Promise<boolean>;
  complete(input: {
    teamId: string;
    callbackId: string;
    callbackType: "event" | "interaction";
    status: "processed" | "ignored" | "failed";
    now: Date;
  }): Promise<void>;
};

export function createPostgresSlackInboundReceiptStore(database: Database): SlackInboundReceiptStore {
  return {
    async claim(input) {
      await database.query(`delete from slack_inbound_receipts where expires_at < $1`, [input.now]);
      const result = await database.query(
        `insert into slack_inbound_receipts
           (team_id, callback_id, callback_type, retry_number, status, received_at, expires_at)
         values ($1, $2, $3, $4, 'received', $5, $6)
         on conflict (team_id, callback_id, callback_type) do update
           set retry_number = excluded.retry_number, status = 'received',
               received_at = excluded.received_at, expires_at = excluded.expires_at,
               updated_at = excluded.received_at
           where slack_inbound_receipts.status = 'failed'
              or (slack_inbound_receipts.status = 'received' and slack_inbound_receipts.updated_at < $7)`,
        [
          input.teamId, input.callbackId, input.callbackType, input.retryNumber, input.now,
          new Date(input.now.getTime() + 24 * 60 * 60 * 1000),
          new Date(input.now.getTime() - 5 * 60 * 1000)
        ]
      );
      return result.rowCount === 1;
    },
    async complete(input) {
      await database.query(
        `update slack_inbound_receipts set status = $4, updated_at = $5
          where team_id = $1 and callback_id = $2 and callback_type = $3`,
        [input.teamId, input.callbackId, input.callbackType, input.status, input.now]
      );
    }
  };
}
