import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { extractSlackObjectMetadata, type ActivityAuditInput, type ActivityAuditRecord } from "../audit/activity";
import { isActivityAuditUnavailableError, type ActivityAuditStore } from "../audit/postgres-store";
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

export type SlackForwardingAudit = {
  store: Pick<ActivityAuditStore, "recordActivity" | "updateActivityOutcome">;
  base: Omit<ActivityAuditInput, "status" | "objectType" | "objectId" | "httpStatus" | "errorClass" | "upstreamCalled">;
};

export async function forwardSlackMethod({
  request,
  method,
  identity,
  requestId,
  client = createDefaultSlackWebApiClient(),
  rateLimiter = checkSlackForwardingRateLimit,
  audit
}: {
  request: NextRequest;
  method: string;
  identity: ResolvedExecutionIdentity;
  requestId: string;
  client?: SlackWebApiClient;
  rateLimiter?: SlackForwardingRateLimiter;
  audit?: SlackForwardingAudit;
}): Promise<NextResponse> {
  const payload = await parseSlackPayload(request);
  if (payload.kind === "error") {
    await audit?.store.recordActivity({
      ...audit.base,
      status: "parse_error",
      errorClass: payload.body.error,
      httpStatus: payload.httpStatus,
      upstreamCalled: false
    });
    return slackApiResponse(payload.body, { requestId, policyDecision: "allowed", executionMode: identity.executionMode, upstreamCalled: false }, payload.httpStatus);
  }

  const rateLimit = rateLimiter({ tokenProfileId: identity.tokenProfileId, method, executionMode: identity.executionMode, requestId });
  if (rateLimit.kind === "limited") {
    await audit?.store.recordActivity({
      ...audit.base,
      ...extractSlackObjectMetadata(method, payload.value),
      status: "rate_limited",
      errorClass: rateLimit.body.error,
      httpStatus: rateLimit.httpStatus,
      upstreamCalled: false
    });
    return slackApiResponse(rateLimit.body, { requestId, policyDecision: "allowed", executionMode: identity.executionMode, upstreamCalled: false }, rateLimit.httpStatus);
  }

  let auditAttempt: ActivityAuditRecord | null = null;
  if (audit) {
    try {
      auditAttempt = await audit.store.recordActivity({
        ...audit.base,
        ...extractSlackObjectMetadata(method, payload.value),
        status: "attempted",
        upstreamCalled: false
      });
    } catch (error) {
      if (isActivityAuditUnavailableError(error)) {
        return auditUnavailableResponse(requestId, identity.executionMode);
      }
      throw error;
    }
  }
  const upstream = await client.callMethod({
    method,
    httpMethod: request.method === "POST" ? "POST" : "GET",
    payload: payload.value,
    executionMode: identity.executionMode
  });
  if (audit && auditAttempt) {
    try {
      await audit.store.updateActivityOutcome(auditAttempt.id, {
        status: isSlackError(upstream.body) ? "upstream_error" : "forwarded",
        errorClass: isSlackError(upstream.body) ? upstream.body.error : null,
        httpStatus: upstream.status,
        upstreamCalled: true
      });
    } catch (error) {
      logActivityAuditUpdateFailure({ requestId, method, auditId: auditAttempt.id, error });
    }
  }
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

function isSlackError(body: unknown): body is { ok: false; error: string } {
  return isRecord(body) && body.ok === false && typeof body.error === "string";
}

function auditUnavailableResponse(requestId: string, executionMode: ResolvedExecutionIdentity["executionMode"]): NextResponse {
  return slackApiResponse({ ok: false, error: "audit_unavailable" }, { requestId, policyDecision: "allowed", executionMode, upstreamCalled: false }, 503);
}

function logActivityAuditUpdateFailure({
  requestId,
  method,
  auditId,
  error
}: {
  requestId: string;
  method: string;
  auditId: string;
  error: unknown;
}): void {
  console.error("prism_activity_audit_update_failed", {
    requestId,
    method,
    auditId,
    errorName: error instanceof Error ? error.name : typeof error
  });
}
