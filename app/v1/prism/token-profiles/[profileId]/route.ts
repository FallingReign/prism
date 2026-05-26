import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { isActivityAuditUnavailableError } from "../../../../../src/server/audit/postgres-store";
import { database } from "../../../../../src/server/db";
import { prismSessionCookieName } from "../../../../../src/server/slack/oauth-flow";
import { deleteTokenProfile } from "../../../../../src/server/token-profiles/service";
import { createPostgresTokenProfileStore } from "../../../../../src/server/token-profiles/store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ profileId: string }> | { profileId: string } };

export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = randomUUID();
  const { profileId } = await context.params;
  try {
    const result = await deleteTokenProfile({
      store: createPostgresTokenProfileStore(database),
      sessionToken: request.cookies.get(prismSessionCookieName)?.value,
      profileId,
      audit: { endpoint: new URL(request.url).pathname, requestId }
    });
    if (result.kind === "deleted") {
      return noStoreJson({ profile: result.profile, slackStatus: result.slackStatus }, 200, requestId);
    }
    if (result.kind === "conflict") {
      return noStoreJson({ error: "active_profile_requires_revoke" }, 409, requestId);
    }
    return noStoreJson({ error: result.kind }, result.kind === "not_found" ? 404 : 401, requestId);
  } catch (error) {
    if (isActivityAuditUnavailableError(error)) return noStoreJson({ error: "audit_unavailable" }, 503, requestId);
    throw error;
  }
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}
