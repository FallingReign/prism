import "server-only";

import type { QueryResultRow } from "pg";

import type { Database } from "../db";
import type { SlackRateLimitStore } from "./rate-limit";

type RateLimitRow = QueryResultRow & {
  request_count: number | string;
  window_reset_at: Date | string;
};

export function createPostgresSlackRateLimitStore(database: Database): SlackRateLimitStore {
  return {
    consume(input) {
      return database.transaction(async (transaction) => {
        const resetAt = new Date(input.now.getTime() + input.windowMs);
        const inserted = await transaction.query(
          `
            insert into slack_forwarding_rate_limits (
              token_profile_id,
              slack_method,
              window_started_at,
              window_reset_at,
              request_count
            )
            values ($1, $2, $3, $4, $5)
            on conflict (token_profile_id, slack_method) do nothing
          `,
          [input.tokenProfileId, input.method, input.now, resetAt, 1]
        );
        if (inserted.rowCount === 1) {
          return { kind: "allowed", resetAt, remaining: Math.max(0, input.maxRequests - 1) };
        }

        const existing = await transaction.query<RateLimitRow>(
          `
            select request_count, window_reset_at
            from slack_forwarding_rate_limits
            where token_profile_id = $1 and slack_method = $2
            for update
          `,
          [input.tokenProfileId, input.method]
        );
        const row = existing.rows[0];
        if (!row) throw new Error("rate-limit-bucket-missing");

        const currentResetAt = toDate(row.window_reset_at);
        if (currentResetAt <= input.now) {
          await transaction.query(
            `
              update slack_forwarding_rate_limits
              set window_started_at = $3,
                  window_reset_at = $4,
                  request_count = $5,
                  updated_at = now()
              where token_profile_id = $1 and slack_method = $2
            `,
            [input.tokenProfileId, input.method, input.now, resetAt, 1]
          );
          return { kind: "allowed", resetAt, remaining: Math.max(0, input.maxRequests - 1) };
        }

        const requestCount = Number(row.request_count);
        if (requestCount >= input.maxRequests) {
          return { kind: "limited", resetAt: currentResetAt, retryAfterSeconds: secondsUntil(input.now, currentResetAt) };
        }

        const updated = await transaction.query<RateLimitRow>(
          `
            update slack_forwarding_rate_limits
            set request_count = request_count + 1,
                updated_at = now()
            where token_profile_id = $1 and slack_method = $2
            returning request_count, window_reset_at
          `,
          [input.tokenProfileId, input.method]
        );
        const updatedRow = updated.rows[0];
        if (!updatedRow) throw new Error("rate-limit-update-failed");

        return {
          kind: "allowed",
          resetAt: toDate(updatedRow.window_reset_at),
          remaining: Math.max(0, input.maxRequests - Number(updatedRow.request_count))
        };
      });
    }
  };
}

function secondsUntil(now: Date, resetAt: Date): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
