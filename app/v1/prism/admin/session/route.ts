import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../../../../src/server/admin/allowlist";
import { resolvePrismAdmin, type AdminAuthorizationDecision } from "../../../../../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../../../../../src/server/admin/postgres-store";
import { database } from "../../../../../src/server/db";
import { prismSessionCookieName } from "../../../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const decision = await resolvePrismAdmin({
      store: createPostgresAdminIdentityStore(database),
      allowlist: await loadAdminAllowlist(),
      sessionToken: request.cookies.get(prismSessionCookieName)?.value
    });
    return adminDecisionResponse(decision, requestId);
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return noStoreJson({ error: "admin_unavailable" }, 503, requestId);
    throw error;
  }
}

function adminDecisionResponse(decision: AdminAuthorizationDecision, requestId: string): NextResponse {
  if (decision.kind === "unauthenticated") return noStoreJson({ error: "unauthorized" }, 401, requestId);
  if (decision.kind === "not_admin") return noStoreJson({ error: "forbidden" }, 403, requestId);
  return noStoreJson(
    {
      admin: true,
      scope: decision.scope,
      slackUser: { id: decision.slackUserId, displayName: decision.slackUserDisplayName },
      team: { id: decision.teamId, name: decision.teamName },
      enterprise: { id: decision.enterpriseId, name: decision.enterpriseName }
    },
    200,
    requestId
  );
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}
