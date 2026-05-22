import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import type { ActivityAuditInput } from "../../../../../src/server/audit/activity";
import { createPostgresActivityAuditStore } from "../../../../../src/server/audit/postgres-store";
import { getDeveloperTokenConfig, isSetupRequiredError } from "../../../../../src/server/config";
import { database } from "../../../../../src/server/db";
import { forwardSlackMethod } from "../../../../../src/server/slack/forwarding";
import { applyPrismDiagnosticsHeaders, type PrismSlackResponseDiagnostics } from "../../../../../src/server/slack/response-adapter";
import { resolveSlackExecutionIdentity } from "../../../../../src/server/token-profiles/execution-identity";
import { evaluateSlackMethodPolicy, type SlackMethodPolicyDecision, type SlackSurface } from "../../../../../src/server/token-profiles/method-policy";
import { createPostgresTokenProfileStore } from "../../../../../src/server/token-profiles/store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ method: string }> | { method: string } };

const slackSurfaces = new Set<SlackSurface>(["public_channel", "private_channel", "dm", "mpim", "search", "files_metadata"]);

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handleSlackMethod(request, context);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handleSlackMethod(request, context);
}

async function handleSlackMethod(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = randomUUID();
  const { method } = await context.params;
  const auditStore = createPostgresActivityAuditStore(database);
  try {
    const decision = await evaluateSlackMethodPolicy({
      store: createPostgresTokenProfileStore(database),
      bearerToken: readBearerToken(request.headers.get("authorization")),
      developerTokenConfig: getDeveloperTokenConfig(),
      method,
      requestId,
      requestContext: {
        workspaceId: request.headers.get("x-prism-workspace-id") ?? undefined,
        surface: readSurface(request.headers.get("x-prism-surface"))
      }
    });
    if (decision.kind !== "allowed") {
      await recordPolicyActivity(auditStore, decision, request, requestId);
      return noStoreJson(decision.body, decision.httpStatus, requestId, { policyDecision: decision.kind, upstreamCalled: false });
    }

    const identity = resolveSlackExecutionIdentity({
      decision,
      executionModeHeader: request.headers.get("x-prism-execution-mode"),
      requestId
    });
    if (identity.kind === "denied") {
      await auditStore.recordActivity({
        ...allowedAuditBase(decision, request, requestId),
        executionMode: decision.capabilityMap.executionIdentity,
        status: "identity_unavailable",
        errorClass: identity.body.prism.errorClass,
        httpStatus: identity.httpStatus,
        upstreamCalled: false
      });
      return noStoreJson(identity.body, identity.httpStatus, requestId, { policyDecision: "denied", upstreamCalled: false });
    }

    return forwardSlackMethod({
      request,
      method: decision.method,
      identity,
      requestId,
      audit: {
        store: auditStore,
        base: {
          ...allowedAuditBase(decision, request, requestId),
          executionMode: identity.executionMode
        }
      }
    });
  } catch (error) {
    if (isSetupRequiredError(error)) {
      return noStoreJson({ ok: false, error: "setup_required", prism: { requestId, method } }, 503, requestId, {
        policyDecision: "auth_failed",
        upstreamCalled: false
      });
    }
    throw error;
  }
}

async function recordPolicyActivity(
  auditStore: ReturnType<typeof createPostgresActivityAuditStore>,
  decision: Exclude<SlackMethodPolicyDecision, { kind: "allowed" }>,
  request: NextRequest,
  requestId: string
): Promise<void> {
  if (!decision.auditContext?.prismUserId) {
    return;
  }
  await auditStore.recordActivity({
    ...decision.auditContext,
    activityType: "slack_method",
    endpoint: new URL(request.url).pathname,
    slackMethod: decision.body.prism.method,
    actionCategory: decision.body.prism.category ?? null,
    surface: readSurface(request.headers.get("x-prism-surface")) ?? null,
    status: decision.kind === "unsupported" ? "unsupported" : decision.kind === "auth_failed" ? "auth_failed" : "denied",
    errorClass: decision.body.prism.errorClass,
    httpStatus: decision.httpStatus,
    requestId,
    upstreamCalled: false
  });
}

function allowedAuditBase(decision: Extract<SlackMethodPolicyDecision, { kind: "allowed" }>, request: NextRequest, requestId: string): Omit<
  ActivityAuditInput,
  "status" | "objectType" | "objectId" | "httpStatus" | "errorClass" | "upstreamCalled"
> {
  return {
    ...decision.auditContext,
    activityType: "slack_method",
    endpoint: new URL(request.url).pathname,
    slackMethod: decision.method,
    actionCategory: decision.category,
    surface: readSurface(request.headers.get("x-prism-surface")) ?? null,
    requestId
  };
}

function readBearerToken(authorization: string | null): string | undefined {
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}

function readSurface(surface: string | null): SlackSurface | undefined {
  return surface && slackSurfaces.has(surface as SlackSurface) ? (surface as SlackSurface) : undefined;
}

function noStoreJson(
  body: unknown,
  status: number,
  requestId: string,
  diagnostics: Omit<PrismSlackResponseDiagnostics, "requestId"> = { policyDecision: "auth_failed", upstreamCalled: false }
): NextResponse {
  const response = NextResponse.json(body, { status });
  return applyPrismDiagnosticsHeaders(response, { requestId, ...diagnostics });
}
