import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../../../../../src/server/admin/allowlist";
import { resolvePrismAdmin } from "../../../../../../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../../../../../../src/server/admin/postgres-store";
import { createPostgresAdminUserDirectoryStore } from "../../../../../../src/server/admin/postgres-user-directory-store";
import { getAdminUserDetail } from "../../../../../../src/server/admin/user-directory";
import { database } from "../../../../../../src/server/db";
import { prismSessionCookieName } from "../../../../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const { userId } = await params;
    const decision = await resolvePrismAdmin({
      store: createPostgresAdminIdentityStore(database),
      allowlist: await loadAdminAllowlist(),
      sessionToken: request.cookies.get(prismSessionCookieName)?.value
    });
    const result = await getAdminUserDetail({
      decision,
      store: createPostgresAdminUserDirectoryStore(database),
      userId,
      profileLimit: limitFromUrl(request.url, "profileLimit", 100),
      activityLimit: limitFromUrl(request.url, "activityLimit", 20)
    });
    if (result.kind === "unauthenticated") return noStoreJson({ error: "unauthorized" }, 401, requestId);
    if (result.kind === "forbidden") return noStoreJson({ error: "forbidden" }, 403, requestId);
    if (result.kind === "not_found") return noStoreJson({ error: "not_found" }, 404, requestId);
    return noStoreJson({ scope: result.scope, detail: result.detail }, 200, requestId);
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return noStoreJson({ error: "admin_unavailable" }, 503, requestId);
    throw error;
  }
}

function limitFromUrl(url: string, key: string, fallback: number): number {
  const raw = new URL(url).searchParams.get(key);
  const parsed = raw ? Number(raw) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}
