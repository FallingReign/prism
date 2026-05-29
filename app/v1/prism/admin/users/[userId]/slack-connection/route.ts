import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../../../../../../src/server/admin/allowlist";
import { resolvePrismAdmin, type AdminAuthorizationDecision } from "../../../../../../../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../../../../../../../src/server/admin/postgres-store";
import { createPostgresAdminUserDirectoryStore } from "../../../../../../../src/server/admin/postgres-user-directory-store";
import { createPostgresAdminSlackConnectionActionStore, removeAdminSlackConnection } from "../../../../../../../src/server/admin/slack-connection-actions";
import { isActivityAuditUnavailableError } from "../../../../../../../src/server/audit/postgres-store";
import { database } from "../../../../../../../src/server/db";
import { prismSessionCookieName } from "../../../../../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ userId: string }> | { userId: string } };

export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = randomUUID();
  const parsedBody = await readActionBody(request);
  if (parsedBody.kind === "invalid_json") return noStoreJson({ error: "invalid_json" }, 400, requestId);

  try {
    const { userId } = await context.params;
    const decision = await authorizeAdmin(request);
    const result = await removeAdminSlackConnection({
      decision,
      directoryStore: createPostgresAdminUserDirectoryStore(database),
      connectionStore: createPostgresAdminSlackConnectionActionStore(database),
      userId,
      reason: parsedBody.reason,
      confirmation: parsedBody.confirmation,
      audit: { endpoint: new URL(request.url).pathname, requestId }
    });

    if (result.kind === "removed") return noStoreJson({ status: "removed", scope: result.scope }, 200, requestId);
    return actionError(result, requestId);
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

async function readActionBody(request: NextRequest): Promise<{ kind: "valid"; reason?: string; confirmation?: string } | { kind: "invalid_json" }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { kind: "invalid_json" };
  }
  if (!isRecord(body)) return { kind: "valid" };
  return {
    kind: "valid",
    reason: typeof body.reason === "string" ? body.reason : undefined,
    confirmation: typeof body.confirmation === "string" ? body.confirmation : undefined
  };
}

function actionError(result: Exclude<Awaited<ReturnType<typeof removeAdminSlackConnection>>, { kind: "removed" }>, requestId: string): NextResponse {
  if (result.kind === "unauthenticated") return noStoreJson({ error: "unauthorized" }, 401, requestId);
  if (result.kind === "forbidden") return noStoreJson({ error: "forbidden" }, 403, requestId);
  if (result.kind === "validation_error") return noStoreJson({ error: "validation_error", message: result.message }, 400, requestId);
  return noStoreJson({ error: "not_found" }, 404, requestId);
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
