import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { createPostgresSlackRateLimitStore } from "./postgres-rate-limit-store";

describe("Postgres Slack forwarding rate-limit store", () => {
  it("tracks fixed-window buckets by Token profile and Slack method without touching Slack credentials", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date("2026-01-01T00:01:01.000Z");
    const buckets = new Map<string, { request_count: number; window_reset_at: Date }>();
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret|payload|body|query/i);
      const key = `${params?.[0]}:${params?.[1]}`;
      if (sql.includes("from slack_forwarding_rate_limits")) {
        const bucket = buckets.get(key);
        return { rows: bucket ? [bucket] : [], rowCount: bucket ? 1 : 0 };
      }
      if (sql.includes("insert into slack_forwarding_rate_limits")) {
        if (buckets.has(key)) return { rows: [], rowCount: 0 };
        buckets.set(key, { request_count: params?.[4] as number, window_reset_at: params?.[3] as Date });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("request_count = request_count + 1")) {
        const bucket = buckets.get(key);
        if (!bucket) throw new Error("missing bucket");
        bucket.request_count += 1;
        return { rows: [bucket], rowCount: 1 };
      }
      if (sql.includes("window_started_at")) {
        buckets.set(key, { request_count: 1, window_reset_at: params?.[3] as Date });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = createPostgresSlackRateLimitStore(fakeDatabase(query));

    await expect(store.consume({ tokenProfileId: "profile_1", method: "conversations.history", maxRequests: 2, windowMs: 60_000, now })).resolves.toMatchObject({
      kind: "allowed",
      remaining: 1
    });
    await expect(store.consume({ tokenProfileId: "profile_1", method: "conversations.history", maxRequests: 2, windowMs: 60_000, now })).resolves.toMatchObject({
      kind: "allowed",
      remaining: 0
    });
    await expect(store.consume({ tokenProfileId: "profile_1", method: "conversations.history", maxRequests: 2, windowMs: 60_000, now })).resolves.toMatchObject({
      kind: "limited",
      retryAfterSeconds: 60
    });
    await expect(store.consume({ tokenProfileId: "profile_1", method: "conversations.list", maxRequests: 2, windowMs: 60_000, now })).resolves.toMatchObject({
      kind: "allowed",
      remaining: 1
    });
    await expect(store.consume({ tokenProfileId: "profile_1", method: "conversations.history", maxRequests: 2, windowMs: 60_000, now: later })).resolves.toMatchObject({
      kind: "allowed",
      remaining: 1
    });
  });
});

function fakeDatabase(query: Database["query"]): Database {
  return {
    query,
    async transaction(callback) {
      return callback(this);
    }
  };
}
