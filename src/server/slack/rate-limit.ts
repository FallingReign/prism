import "server-only";

import type { ConcreteExecutionMode } from "../token-profiles/execution-identity";

export type SlackRateLimitConfig = {
  maxRequests: number;
  windowMs: number;
};

export type SlackRateLimitInput = {
  tokenProfileId: string;
  method: string;
  executionMode: ConcreteExecutionMode;
  requestId: string;
};

export type SlackRateLimitStore = {
  consume(input: {
    tokenProfileId: string;
    method: string;
    maxRequests: number;
    windowMs: number;
    now: Date;
  }): Promise<{ kind: "allowed"; resetAt: Date; remaining: number } | { kind: "limited"; resetAt: Date; retryAfterSeconds: number }>;
};

export type SlackForwardingRateLimitDecision =
  | { kind: "allowed" }
  | { kind: "limited"; httpStatus: 429; retryAfterSeconds: number; body: { ok: false; error: "rate_limited" } };

export type SlackForwardingRateLimiter = (input: SlackRateLimitInput) => SlackForwardingRateLimitDecision | Promise<SlackForwardingRateLimitDecision>;

const DEFAULT_MAX_REQUESTS = 120;
const DEFAULT_WINDOW_MS = 60_000;

export function createSlackForwardingRateLimiter({
  store,
  config = defaultSlackRateLimitConfig(),
  now = () => new Date()
}: {
  store: SlackRateLimitStore;
  config?: SlackRateLimitConfig;
  now?: () => Date;
}): SlackForwardingRateLimiter {
  return async ({ tokenProfileId, method }) => {
    const result = await store.consume({
      tokenProfileId,
      method,
      maxRequests: config.maxRequests,
      windowMs: config.windowMs,
      now: now()
    });

    if (result.kind === "allowed") return { kind: "allowed" };
    return {
      kind: "limited",
      httpStatus: 429,
      retryAfterSeconds: Math.max(1, result.retryAfterSeconds),
      body: { ok: false, error: "rate_limited" }
    };
  };
}

export function defaultSlackRateLimitConfig(env: NodeJS.ProcessEnv = process.env): SlackRateLimitConfig {
  return {
    maxRequests: positiveInteger(env.PRISM_RATE_LIMIT_MAX_REQUESTS) ?? DEFAULT_MAX_REQUESTS,
    windowMs: (positiveInteger(env.PRISM_RATE_LIMIT_WINDOW_SECONDS) ?? DEFAULT_WINDOW_MS / 1000) * 1000
  };
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
