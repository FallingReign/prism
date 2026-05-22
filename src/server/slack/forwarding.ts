import "server-only";

import { NextRequest, NextResponse } from "next/server";

import type { SlackExecutionIdentityDecision } from "../token-profiles/execution-identity";
import { slackApiResponse } from "./response-adapter";
import { createDefaultSlackWebApiClient, type SlackForwardingPayload, type SlackWebApiClient } from "./web-api-client";

type ResolvedExecutionIdentity = Extract<SlackExecutionIdentityDecision, { kind: "resolved" }>;
type SlackForwardingRateLimitDecision = { kind: "allowed" } | { kind: "limited"; httpStatus: number; body: { ok: false; error: "rate_limited" } };
export type SlackForwardingRateLimiter = (input: {
  tokenProfileId: string;
  method: string;
  executionMode: ResolvedExecutionIdentity["executionMode"];
  requestId: string;
}) => SlackForwardingRateLimitDecision;

export async function forwardSlackMethod({
  request,
  method,
  identity,
  requestId,
  client = createDefaultSlackWebApiClient(),
  rateLimiter = checkSlackForwardingRateLimit
}: {
  request: NextRequest;
  method: string;
  identity: ResolvedExecutionIdentity;
  requestId: string;
  client?: SlackWebApiClient;
  rateLimiter?: SlackForwardingRateLimiter;
}): Promise<NextResponse> {
  const payload = await parseSlackPayload(request);
  if (payload.kind === "error") {
    return slackApiResponse(payload.body, { requestId, policyDecision: "allowed", executionMode: identity.executionMode, upstreamCalled: false }, payload.httpStatus);
  }

  const rateLimit = rateLimiter({ tokenProfileId: identity.tokenProfileId, method, executionMode: identity.executionMode, requestId });
  if (rateLimit.kind === "limited") {
    return slackApiResponse(rateLimit.body, { requestId, policyDecision: "allowed", executionMode: identity.executionMode, upstreamCalled: false }, rateLimit.httpStatus);
  }

  const upstream = await client.callMethod({
    method,
    httpMethod: request.method === "POST" ? "POST" : "GET",
    payload: payload.value,
    executionMode: identity.executionMode
  });
  return slackApiResponse(upstream.body, { requestId, policyDecision: "allowed", executionMode: identity.executionMode, upstreamCalled: true }, upstream.status);
}

export function checkSlackForwardingRateLimit(): SlackForwardingRateLimitDecision {
  return { kind: "allowed" };
}

async function parseSlackPayload(
  request: NextRequest
): Promise<{ kind: "payload"; value: SlackForwardingPayload } | { kind: "error"; httpStatus: number; body: { ok: false; error: string } }> {
  if (request.method !== "POST") return { kind: "payload", value: paramsToPayload(new URL(request.url).searchParams) };

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("multipart/form-data")) return { kind: "error", httpStatus: 200, body: { ok: false, error: "method_not_supported" } };
  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return { kind: "error", httpStatus: 200, body: { ok: false, error: "invalid_json" } };
    }
    if (!isRecord(body)) return { kind: "error", httpStatus: 200, body: { ok: false, error: "json_not_object" } };
    return { kind: "payload", value: stripLocalToolToken(body) };
  }

  return { kind: "payload", value: paramsToPayload(new URLSearchParams(await request.text())) };
}

function paramsToPayload(params: URLSearchParams): SlackForwardingPayload {
  const payload: SlackForwardingPayload = {};
  for (const key of new Set(params.keys())) {
    if (key.toLowerCase() === "token") continue;
    const values = params.getAll(key);
    payload[key] = values.length > 1 ? values : values[0] ?? "";
  }
  return payload;
}

function stripLocalToolToken(body: Record<string, unknown>): SlackForwardingPayload {
  const { token: _token, ...payload } = body;
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
