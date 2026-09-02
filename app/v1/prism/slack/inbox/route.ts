import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { database } from "../../../../../src/server/db";
import { leasePrismInbox } from "../../../../../src/server/slack/prism-inbox";
import { authenticatePrismInboxRequest, prismInboxJson } from "../../../../../src/server/slack/prism-inbox-http";
import { createPostgresPrismInboxStore } from "../../../../../src/server/slack/postgres-prism-inbox-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const auth = await authenticatePrismInboxRequest(request, requestId);
  if (auth.kind === "response") return auth.response;
  const url = new URL(request.url);
  const limit = boundedInteger(url.searchParams.get("limit"), 10, 1, 50);
  const waitSeconds = boundedInteger(url.searchParams.get("wait"), 0, 0, 25);
  const deadline = Date.now() + waitSeconds * 1000;
  const store = createPostgresPrismInboxStore(database);

  do {
    const deliveries = await leasePrismInbox({ store, tokenProfileId: auth.resolved.tokenProfileId, limit, now: new Date() });
    if (deliveries.length > 0 || Date.now() >= deadline) {
      return prismInboxJson({
        ok: true,
        requestId,
        deliveries: deliveries.map((delivery) => ({
          ...delivery,
          receivedAt: delivery.receivedAt.toISOString(),
          expiresAt: delivery.expiresAt.toISOString()
        }))
      }, 200, requestId);
    }
    await delay(250);
  } while (Date.now() < deadline);

  return prismInboxJson({ ok: true, requestId, deliveries: [] }, 200, requestId);
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  return Math.max(minimum, Math.min(Number(value), maximum));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
