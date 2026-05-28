import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../../../../src/server/admin/allowlist";
import { resolvePrismAdmin } from "../../../../../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../../../../../src/server/admin/postgres-store";
import { createPostgresAdminUserDirectoryStore } from "../../../../../src/server/admin/postgres-user-directory-store";
import { listAdminUsers } from "../../../../../src/server/admin/user-directory";
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
    const result = await listAdminUsers({ decision, store: createPostgresAdminUserDirectoryStore(database), limit: limitFromUrl(request.url) });
    if (result.kind === "unauthenticated") return noStoreJson({ error: "unauthorized" }, 401, requestId);
    if (result.kind === "forbidden") return noStoreJson({ error: "forbidden" }, 403, requestId);
    return noStoreJson({ scope: result.scope, users: result.users }, 200, requestId);
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return noStoreJson({ error: "admin_unavailable" }, 503, requestId);
    throw error;
  }
}

function limitFromUrl(url: string): number {
  const raw = new URL(url).searchParams.get("limit");
  const parsed = raw ? Number(raw) : 50;
  return Number.isFinite(parsed) ? parsed : 50;
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}
