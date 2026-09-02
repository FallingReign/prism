import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { database } from "../../../../../../src/server/db";
import { authenticatePrismInboxRequest, prismInboxJson } from "../../../../../../src/server/slack/prism-inbox-http";
import { createPostgresPrismInboxStore } from "../../../../../../src/server/slack/postgres-prism-inbox-store";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ routeId: string }> | { routeId: string } };

export async function DELETE(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  const auth = await authenticatePrismInboxRequest(request, requestId);
  if (auth.kind === "response") return auth.response;
  const { routeId } = await context.params;
  if (!isUuid(routeId)) return prismInboxJson({ ok: false, error: "invalid_route", requestId }, 400, requestId);
  const closed = await createPostgresPrismInboxStore(database).closeRoute({ routeId, tokenProfileId: auth.resolved.tokenProfileId, now: new Date() });
  return prismInboxJson({ ok: true, requestId, closed }, 200, requestId);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
