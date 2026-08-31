import "server-only";

import type { Database } from "../db";
import type { RemoteCodexSlackRateLimiter } from "./internal-slack-service";

export function createRemoteCodexSlackRateLimiter(
  database: Database,
  { maxRequests = 60, windowMs = 60_000, now = () => new Date() }: { maxRequests?: number; windowMs?: number; now?: () => Date } = {}
): RemoteCodexSlackRateLimiter {
  return async ({ ownerKey, method }) =>
    database.transaction(async (transaction) => {
      const currentTime = now();
      const resetAt = new Date(currentTime.getTime() + windowMs);
      const inserted = await transaction.query(
        `insert into remote_codex_slack_rate_limits
           (owner_key, slack_method, window_started_at, window_reset_at, request_count)
         values ($1, $2, $3, $4, 1)
         on conflict (owner_key, slack_method) do nothing`,
        [ownerKey, method, currentTime, resetAt]
      );
      if (inserted.rowCount === 1) return { kind: "allowed" } as const;
      const existing = await transaction.query<{ request_count: number | string; window_reset_at: Date | string }>(
        `select request_count, window_reset_at
           from remote_codex_slack_rate_limits
          where owner_key = $1 and slack_method = $2
          for update`,
        [ownerKey, method]
      );
      const row = existing.rows[0];
      if (!row) return { kind: "limited" } as const;
      if (new Date(row.window_reset_at) <= currentTime) {
        await transaction.query(
          `update remote_codex_slack_rate_limits
              set window_started_at = $3, window_reset_at = $4, request_count = 1, updated_at = $3
            where owner_key = $1 and slack_method = $2`,
          [ownerKey, method, currentTime, resetAt]
        );
        return { kind: "allowed" } as const;
      }
      if (Number(row.request_count) >= maxRequests) return { kind: "limited" } as const;
      await transaction.query(
        `update remote_codex_slack_rate_limits
            set request_count = request_count + 1, updated_at = $3
          where owner_key = $1 and slack_method = $2`,
        [ownerKey, method, currentTime]
      );
      return { kind: "allowed" } as const;
    });
}
