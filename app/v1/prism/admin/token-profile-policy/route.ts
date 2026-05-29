import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../../../../src/server/admin/allowlist";
import { resolvePrismAdmin, type AdminAuthorizationDecision } from "../../../../../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../../../../../src/server/admin/postgres-store";
import { isActivityAuditUnavailableError } from "../../../../../src/server/audit/postgres-store";
import { database } from "../../../../../src/server/db";
import { prismSessionCookieName } from "../../../../../src/server/slack/oauth-flow";
import { parseGlobalTokenProfilePolicy, type GlobalTokenProfilePolicy } from "../../../../../src/server/token-profiles/global-policy";
import { createPostgresGlobalTokenProfilePolicyStore, type GlobalTokenProfilePolicySettings } from "../../../../../src/server/token-profiles/global-policy-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const decision = await authorizeAdmin(request);
    if (decision.kind !== "authorized") return adminDecisionError(decision, requestId);
    const settings = await createPostgresGlobalTokenProfilePolicyStore(database).readGlobalTokenProfilePolicy();
    return noStoreJson(policyResponseBody(decision, settings), 200, requestId);
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return noStoreJson({ error: "admin_unavailable" }, 503, requestId);
    throw error;
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const parsedBody = await readPolicyBody(request);
  if (parsedBody.kind === "invalid_json") return noStoreJson({ error: "invalid_json" }, 400, requestId);
  if (parsedBody.kind === "invalid_policy") return noStoreJson({ error: "invalid_policy", message: parsedBody.message }, 400, requestId);

  try {
    const decision = await authorizeAdmin(request);
    if (decision.kind !== "authorized") return adminDecisionError(decision, requestId);
    if (decision.scope.kind !== "global") return noStoreJson({ error: "forbidden" }, 403, requestId);

    const settings = await createPostgresGlobalTokenProfilePolicyStore(database).updateGlobalTokenProfilePolicy({
      policy: parsedBody.policy,
      updatedByPrismUserId: decision.prismUserId,
      audit: { endpoint: new URL(request.url).pathname, requestId }
    });
    return noStoreJson(policyResponseBody(decision, settings), 200, requestId);
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return noStoreJson({ error: "admin_unavailable" }, 503, requestId);
    if (isActivityAuditUnavailableError(error)) return noStoreJson({ error: "audit_unavailable" }, 503, requestId);
    throw error;
  }
}

async function authorizeAdmin(request: NextRequest): Promise<AdminAuthorizationDecision> {
  return resolvePrismAdmin({
    store: createPostgresAdminIdentityStore(database),
    allowlist: await loadAdminAllowlist(),
    sessionToken: request.cookies.get(prismSessionCookieName)?.value
  });
}

async function readPolicyBody(request: NextRequest): Promise<{ kind: "valid"; policy: GlobalTokenProfilePolicy } | { kind: "invalid_json" } | { kind: "invalid_policy"; message: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { kind: "invalid_json" };
  }
  const policyValue = isRecord(body) && "policy" in body ? body.policy : body;
  const parsed = parseGlobalTokenProfilePolicy(policyValue);
  return parsed.kind === "valid" ? { kind: "valid", policy: parsed.policy } : { kind: "invalid_policy", message: parsed.message };
}

function policyResponseBody(decision: Extract<AdminAuthorizationDecision, { kind: "authorized" }>, settings: GlobalTokenProfilePolicySettings) {
  return {
    policy: settings.policy,
    version: settings.version,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
    updatedByPrismUserId: settings.updatedByPrismUserId,
    editable: decision.scope.kind === "global",
    scope: decision.scope
  };
}

function adminDecisionError(decision: AdminAuthorizationDecision, requestId: string): NextResponse {
  if (decision.kind === "unauthenticated") return noStoreJson({ error: "unauthorized" }, 401, requestId);
  return noStoreJson({ error: "forbidden" }, 403, requestId);
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
