import { describe, expect, it } from "vitest";

import { createSlackForwardingRateLimiter, type SlackRateLimitStore } from "./rate-limit";

describe("Slack forwarding Prism-side rate limits", () => {
  it("limits a Token profile and Slack method within a fixed window, then resets predictably", async () => {
    const store = createMemoryStore();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const rateLimiter = createSlackForwardingRateLimiter({
      store,
      config: { maxRequests: 2, windowMs: 60_000 },
      now: () => now
    });

    await expect(rateLimiter(input({ method: "conversations.history" }))).resolves.toMatchObject({ kind: "allowed" });
    await expect(rateLimiter(input({ method: "conversations.history" }))).resolves.toMatchObject({ kind: "allowed" });
    await expect(rateLimiter(input({ method: "conversations.history" }))).resolves.toMatchObject({
      kind: "limited",
      httpStatus: 429,
      retryAfterSeconds: 60,
      body: { ok: false, error: "rate_limited" }
    });

    await expect(rateLimiter(input({ method: "conversations.list" }))).resolves.toMatchObject({ kind: "allowed" });
    await expect(rateLimiter(input({ tokenProfileId: "profile_2", method: "conversations.history" }))).resolves.toMatchObject({ kind: "allowed" });

    now = new Date("2026-01-01T00:01:01.000Z");
    await expect(rateLimiter(input({ method: "conversations.history" }))).resolves.toMatchObject({ kind: "allowed" });
  });
});

function input(overrides: Partial<Parameters<ReturnType<typeof createSlackForwardingRateLimiter>>[0]> = {}) {
  return {
    tokenProfileId: "profile_1",
    method: "conversations.history",
    executionMode: "bot" as const,
    requestId: "req_rate_limit",
    ...overrides
  };
}

function createMemoryStore(): SlackRateLimitStore {
  const buckets = new Map<string, { count: number; resetAt: Date }>();
  return {
    async consume({ tokenProfileId, method, maxRequests, windowMs, now }) {
      const key = `${tokenProfileId}:${method}`;
      const current = buckets.get(key);
      if (!current || current.resetAt <= now) {
        const resetAt = new Date(now.getTime() + windowMs);
        buckets.set(key, { count: 1, resetAt });
        return { kind: "allowed", resetAt, remaining: maxRequests - 1 };
      }
      if (current.count >= maxRequests) {
        return { kind: "limited", resetAt: current.resetAt, retryAfterSeconds: Math.ceil((current.resetAt.getTime() - now.getTime()) / 1000) };
      }
      current.count += 1;
      return { kind: "allowed", resetAt: current.resetAt, remaining: maxRequests - current.count };
    }
  };
}
