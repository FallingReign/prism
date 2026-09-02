import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { extractSlackObjectMetadata, type ActivityAuditInput, type ActivityAuditRecord } from "../audit/activity";
import { isActivityAuditUnavailableError, type ActivityAuditStore } from "../audit/postgres-store";
import { createConfiguredCredentialCipher } from "../credentials/factory";
import { database } from "../db";
import type { SlackExecutionIdentityDecision } from "../token-profiles/execution-identity";
import { createConfiguredSlackOAuthClient } from "./app-configuration-factory";
import { createPostgresSlackRateLimitStore } from "./postgres-rate-limit-store";
import { createPostgresRefreshStore } from "./postgres-store";
import { createSlackForwardingCredentialProvider, type SlackForwardingCredentialProvider } from "./forwarding-credentials";
import { createSlackForwardingRateLimiter, defaultSlackRateLimitConfig, type SlackForwardingRateLimiter } from "./rate-limit";
import { slackApiResponse } from "./response-adapter";
import { createDefaultSlackWebApiClient, type SlackForwardingPayload, type SlackPayloadEncoding, type SlackWebApiCall, type SlackWebApiClient } from "./web-api-client";

type ResolvedExecutionIdentity = Extract<SlackExecutionIdentityDecision, { kind: "resolved" }>;
const MAX_SLACK_PAYLOAD_BYTES = 1024 * 1024;
const defaultSlackForwardingRateLimiter = createSlackForwardingRateLimiter({
  store: createPostgresSlackRateLimitStore(database),
  config: defaultSlackRateLimitConfig()
});

export const checkSlackForwardingRateLimit: SlackForwardingRateLimiter = (input) => defaultSlackForwardingRateLimiter(input);

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
  credentialProvider,
  audit
}: {
  request: NextRequest;
  method: string;
  identity: ResolvedExecutionIdentity;
  requestId: string;
  client?: SlackWebApiClient;
  rateLimiter?: SlackForwardingRateLimiter;
  credentialProvider?: SlackForwardingCredentialProvider;
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
  const workspacePayload = constrainWorkspaceTeamId(payload.value, request.headers.get("x-prism-workspace-id"));
  if (workspacePayload.kind === "error") {
    await audit?.store.recordActivity({
      ...audit.base,
      status: "parse_error",
      errorClass: workspacePayload.body.error,
      httpStatus: workspacePayload.httpStatus,
      upstreamCalled: false
    });
    return slackApiResponse(
      workspacePayload.body,
      { requestId, policyDecision: "allowed", executionMode: identity.executionMode, upstreamCalled: false },
      workspacePayload.httpStatus
    );
  }
  const slackPayload = workspacePayload.value;

  const rateLimit = await rateLimiter({ tokenProfileId: identity.tokenProfileId, method, executionMode: identity.executionMode, requestId });
  if (rateLimit.kind === "limited") {
    await audit?.store.recordActivity({
      ...audit.base,
      ...extractSlackObjectMetadata(method, slackPayload),
      status: "rate_limited",
      errorClass: rateLimit.body.error,
      httpStatus: rateLimit.httpStatus,
      upstreamCalled: false
    });
    const response = slackApiResponse(rateLimit.body, { requestId, policyDecision: "allowed", executionMode: identity.executionMode, upstreamCalled: false }, rateLimit.httpStatus);
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return response;
  }

  let auditAttempt: ActivityAuditRecord | null = null;
  if (audit) {
    try {
      auditAttempt = await audit.store.recordActivity({
        ...audit.base,
        ...extractSlackObjectMetadata(method, slackPayload),
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
  let accessToken: string | undefined;
  let effectiveCredentialProvider: SlackForwardingCredentialProvider | undefined;
  if (client.requiresAccessToken) {
    effectiveCredentialProvider =
      credentialProvider ?? (await createDefaultSlackForwardingCredentialProvider());
    const credential = await effectiveCredentialProvider.getAccessToken({
      connectionId: identity.slackConnectionId,
      kind: identity.executionMode
    });
    if (credential.kind === "unavailable") {
      await updateAuditOutcome({
        audit,
        auditAttempt,
        requestId,
        method,
        outcome: { status: "upstream_error", errorClass: credential.errorClass, httpStatus: 200, upstreamCalled: false }
      });
      return slackApiResponse({ ok: false, error: credential.error }, { requestId, policyDecision: "allowed", executionMode: identity.executionMode, upstreamCalled: false });
    }
    accessToken = credential.accessToken;
  }

  const httpMethod: SlackWebApiCall["httpMethod"] = request.method === "POST" ? "POST" : "GET";
  const call: SlackWebApiCall = {
    method,
    httpMethod,
    payloadEncoding: payload.encoding,
    payload: slackPayload,
    executionMode: identity.executionMode,
    ...(accessToken ? { accessToken } : {})
  };
  const upstream = await client.callMethod(call);
  if (isSlackError(upstream.body) && isCredentialRejection(upstream.body.error) && effectiveCredentialProvider?.markReauthRequired) {
    try {
      await effectiveCredentialProvider.markReauthRequired({
        connectionId: identity.slackConnectionId,
        errorClass: upstream.body.error
      });
    } catch (error) {
      console.error("prism_slack_connection_reauth_status_update_failed", {
        requestId,
        method,
        errorName: error instanceof Error ? error.name : typeof error
      });
    }
  }
  if (audit && auditAttempt) {
    await updateAuditOutcome({
      audit,
      auditAttempt,
      requestId,
      method,
      outcome: {
        status: isSlackError(upstream.body) ? "upstream_error" : "forwarded",
        errorClass: isSlackError(upstream.body) ? upstream.body.error : null,
        httpStatus: upstream.status,
        upstreamCalled: true
      }
    });
  }
  const response = slackApiResponse(upstream.body, { requestId, policyDecision: "allowed", executionMode: identity.executionMode, upstreamCalled: true }, upstream.status);
  applySelectedUpstreamHeaders(response, upstream.headers);
  return response;
}

async function parseSlackPayload(
  request: NextRequest
): Promise<
  | { kind: "payload"; value: SlackForwardingPayload; encoding: SlackPayloadEncoding }
  | { kind: "error"; httpStatus: number; body: { ok: false; error: string } }
> {
  if (request.method !== "POST") return { kind: "payload", value: paramsToPayload(new URL(request.url).searchParams), encoding: "query" };

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SLACK_PAYLOAD_BYTES) {
    return { kind: "error", httpStatus: 413, body: { ok: false, error: "request_too_large" } };
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("multipart/form-data")) return { kind: "error", httpStatus: 200, body: { ok: false, error: "method_not_supported" } };
  const raw = await readBoundedText(request, MAX_SLACK_PAYLOAD_BYTES);
  if (raw === null) return { kind: "error", httpStatus: 413, body: { ok: false, error: "request_too_large" } };
  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return { kind: "error", httpStatus: 200, body: { ok: false, error: "invalid_json" } };
    }
    if (!isRecord(body)) return { kind: "error", httpStatus: 200, body: { ok: false, error: "json_not_object" } };
    return { kind: "payload", value: stripLocalToolToken(body), encoding: "json" };
  }

  return { kind: "payload", value: paramsToPayload(new URLSearchParams(raw)), encoding: "form" };
}

async function readBoundedText(request: NextRequest, maximumBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let value = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
    return value + decoder.decode();
  } catch {
    return null;
  }
}

async function createDefaultSlackForwardingCredentialProvider(): Promise<SlackForwardingCredentialProvider> {
  return createSlackForwardingCredentialProvider({
    store: createPostgresRefreshStore(database),
    cipher: createConfiguredCredentialCipher(),
    slackOAuthClient: await createConfiguredSlackOAuthClient({ database })
  });
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

function constrainWorkspaceTeamId(
  payload: SlackForwardingPayload,
  workspaceId: string | null
):
  | { kind: "payload"; value: SlackForwardingPayload }
  | { kind: "error"; httpStatus: 403; body: { ok: false; error: "workspace_mismatch" } } {
  const normalized = workspaceId?.trim();
  if (!normalized) return { kind: "payload", value: payload };
  if ("team_id" in payload && payload.team_id !== normalized) {
    return { kind: "error", httpStatus: 403, body: { ok: false, error: "workspace_mismatch" } };
  }
  return { kind: "payload", value: { ...payload, team_id: normalized } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSlackError(body: unknown): body is { ok: false; error: string } {
  return isRecord(body) && body.ok === false && typeof body.error === "string";
}

function isCredentialRejection(error: string): boolean {
  return (
    error === "not_authed" ||
    error === "invalid_auth" ||
    error === "token_revoked" ||
    error === "token_expired" ||
    error === "account_inactive"
  );
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

async function updateAuditOutcome({
  audit,
  auditAttempt,
  requestId,
  method,
  outcome
}: {
  audit: SlackForwardingAudit | undefined;
  auditAttempt: ActivityAuditRecord | null;
  requestId: string;
  method: string;
  outcome: { status: "forwarded" | "upstream_error"; errorClass: string | null; httpStatus: number; upstreamCalled: boolean };
}): Promise<void> {
  if (!audit || !auditAttempt) return;
  try {
    await audit.store.updateActivityOutcome(auditAttempt.id, outcome);
  } catch (error) {
    logActivityAuditUpdateFailure({ requestId, method, auditId: auditAttempt.id, error });
  }
}

function applySelectedUpstreamHeaders(response: NextResponse, headers: Headers | Record<string, string | undefined> | undefined): void {
  for (const header of ["retry-after", "x-slack-req-id"]) {
    const value = readHeader(headers, header);
    if (value) response.headers.set(header, value);
  }
}

function readHeader(headers: Headers | Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}
