import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../../../../../../src/server/admin/allowlist";
import { resolvePrismAdmin } from "../../../../../../../src/server/admin/authorization";
import { createPostgresGlobalAdminActionStore, grantGlobalAdmin, revokeGlobalAdmin } from "../../../../../../../src/server/admin/global-admin-actions";
import { createPostgresAdminIdentityStore } from "../../../../../../../src/server/admin/postgres-store";
import { isActivityAuditUnavailableError } from "../../../../../../../src/server/audit/postgres-store";
import { database } from "../../../../../../../src/server/db";
import { rejectCrossOriginBrowserMutation } from "../../../../../../../src/server/http/browser-mutation-csrf";
import { prismSessionCookieName } from "../../../../../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ userId: string }> | { userId: string } };

export async function PUT(request: NextRequest, context: RouteContext): Promise<NextResponse> { return mutate("grant", request, context); }
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> { return mutate("revoke", request, context); }

async function mutate(action: "grant" | "revoke", request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const csrfRejection = rejectCrossOriginBrowserMutation(request);
  if (csrfRejection) return csrfRejection;
  const requestId = randomUUID();
  const body = await readActionBody(request);
  if (body.kind === "invalid_json") return noStoreJson({ error: "invalid_json" }, 400, requestId);
  try {
    const { userId } = await context.params;
    const decision = await resolvePrismAdmin({ store: createPostgresAdminIdentityStore(database), allowlist: loadAdminAllowlist, sessionToken: request.cookies.get(prismSessionCookieName)?.value });
    const shared = { decision, store: createPostgresGlobalAdminActionStore(database), targetPrismUserId: userId, reason: body.reason, confirmation: body.confirmation, audit: { endpoint: new URL(request.url).pathname, requestId } };
    const result = action === "grant" ? await grantGlobalAdmin(shared) : await revokeGlobalAdmin(shared);
    if (["granted", "revoked", "already_admin", "not_admin"].includes(result.kind)) return noStoreJson({ status: result.kind }, 200, requestId);
    return actionError(result, requestId);
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return noStoreJson({ error: "admin_unavailable" }, 503, requestId);
    if (isActivityAuditUnavailableError(error)) return noStoreJson({ error: "audit_unavailable" }, 503, requestId);
    throw error;
  }
}

async function readActionBody(request: NextRequest): Promise<{ kind: "valid"; reason?: string; confirmation?: string } | { kind: "invalid_json" }> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object") return { kind: "valid" };
    const record = body as Record<string, unknown>;
    return { kind: "valid", reason: typeof record.reason === "string" ? record.reason : undefined, confirmation: typeof record.confirmation === "string" ? record.confirmation : undefined };
  } catch { return { kind: "invalid_json" }; }
}

function actionError(result: { kind: string; message?: string }, requestId: string): NextResponse {
  if (result.kind === "unauthenticated") return noStoreJson({ error: "unauthorized" }, 401, requestId);
  if (result.kind === "forbidden") return noStoreJson({ error: "forbidden" }, 403, requestId);
  if (result.kind === "validation_error") return noStoreJson({ error: "validation_error", message: result.message }, 400, requestId);
  if (result.kind === "self_demotion_forbidden" || result.kind === "last_admin_forbidden") return noStoreJson({ error: result.kind }, 409, requestId);
  return noStoreJson({ error: "not_found" }, 404, requestId);
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}
