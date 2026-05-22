import { NextRequest, NextResponse } from "next/server";

import { createPostgresActivityAuditStore } from "../../../../src/server/audit/postgres-store";
import { toActivityAuditSummary } from "../../../../src/server/audit/presentation";
import { database } from "../../../../src/server/db";
import { prismSessionCookieName } from "../../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const activity = await createPostgresActivityAuditStore(database).listRecentActivityForSession({
    sessionToken: request.cookies.get(prismSessionCookieName)?.value,
    limit: readLimit(request)
  });
  const response = NextResponse.json({ activity: activity.map(toActivityAuditSummary) }, { status: 200 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function readLimit(request: NextRequest): number {
  const raw = new URL(request.url).searchParams.get("limit");
  if (!raw) {
    return 20;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : 20;
}
