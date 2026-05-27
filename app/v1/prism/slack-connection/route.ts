import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { isActivityAuditUnavailableError } from "../../../../src/server/audit/postgres-store";
import { database } from "../../../../src/server/db";
import { createPostgresSlackConnectionManagementStore, removeSlackConnection } from "../../../../src/server/slack/connection-management";
import { prismSessionCookieName } from "../../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const result = await removeSlackConnection({
      store: createPostgresSlackConnectionManagementStore(database),
      sessionToken: request.cookies.get(prismSessionCookieName)?.value,
      audit: { endpoint: new URL(request.url).pathname, requestId }
    });

    if (result.kind === "removed") return noStoreJson({ status: "removed" }, 200, requestId);
    if (result.kind === "not_found") return noStoreJson({ error: "not_found" }, 404, requestId);
    return noStoreJson({ error: result.kind }, result.kind === "unauthenticated" ? 401 : 409, requestId);
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
