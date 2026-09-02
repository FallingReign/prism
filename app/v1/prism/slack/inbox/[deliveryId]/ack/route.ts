import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { database } from "../../../../../../../src/server/db";
import { acknowledgePrismInboxDelivery } from "../../../../../../../src/server/slack/prism-inbox";
import { authenticatePrismInboxRequest, prismInboxJson, readJsonRecord } from "../../../../../../../src/server/slack/prism-inbox-http";
import { createPostgresPrismInboxStore } from "../../../../../../../src/server/slack/postgres-prism-inbox-store";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ deliveryId: string }> | { deliveryId: string } };

export async function POST(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  const auth = await authenticatePrismInboxRequest(request, requestId);
  if (auth.kind === "response") return auth.response;
  const body = await readJsonRecord(request);
  const leaseId = typeof body?.leaseId === "string" ? body.leaseId : "";
  const { deliveryId } = await context.params;
  if (!isUuid(deliveryId) || !isUuid(leaseId)) return prismInboxJson({ ok: false, error: "invalid_ack", requestId }, 400, requestId);
  const result = await acknowledgePrismInboxDelivery({
    store: createPostgresPrismInboxStore(database),
    tokenProfileId: auth.resolved.tokenProfileId,
    deliveryId,
    leaseId,
    now: new Date()
  });
  if (result === "not_found") return prismInboxJson({ ok: false, error: "delivery_not_found", requestId }, 404, requestId);
  if (result === "lease_mismatch") return prismInboxJson({ ok: false, error: "lease_mismatch", requestId }, 409, requestId);
  return prismInboxJson({ ok: true, requestId, acknowledged: true }, 200, requestId);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
