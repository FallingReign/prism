import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getRemoteCodexConfig } from "@/src/server/config";
import { database } from "@/src/server/db";
import { scheduleAfterResponse } from "@/src/server/http/deferred-work";
import { verifyRunnerRequest } from "@/src/server/remote-codex/runner-auth";
import { publishBoundSessionStatuses } from "@/src/server/remote-codex/binding-status";
import { createDefaultRemoteCodexSlackService } from "@/src/server/remote-codex/internal-slack-service";
import { createPostgresRunnerAuthStore, createPostgresSessionCatalogStore } from "@/src/server/remote-codex/runner-postgres-store";
import { syncSessionCatalog } from "@/src/server/remote-codex/session-service";
import { createRemoteCodexSlackRateLimiter } from "@/src/server/remote-codex/slack-rate-limit";

export const dynamic = "force-dynamic";
const maxCatalogBytes = 256 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (!getRemoteCodexConfig().enabled) return noStoreJson({ error: "not_found" }, 404, requestId);
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > maxCatalogBytes) {
    return noStoreJson({ error: "invalid_catalog" }, 400, requestId);
  }

  const body = await request.text();
  if (Buffer.byteLength(body) > maxCatalogBytes) return noStoreJson({ error: "invalid_catalog" }, 400, requestId);
  const accessToken = bearerToken(request.headers.get("authorization"));
  const installationId = request.headers.get("x-prism-installation-id");
  const timestamp = request.headers.get("x-prism-timestamp");
  const nonce = request.headers.get("x-prism-nonce");
  const signature = request.headers.get("x-prism-signature");
  if (!accessToken || !installationId || !timestamp || !nonce || !signature) {
    return noStoreJson({ error: "invalid_runner_auth" }, 401, requestId);
  }

  const auth = await verifyRunnerRequest({
    store: createPostgresRunnerAuthStore(database),
    method: request.method,
    path: new URL(request.url).pathname,
    body,
    installationId,
    accessToken,
    timestamp,
    nonce,
    signature
  });
  if (auth.kind !== "authenticated") return noStoreJson({ error: "invalid_runner_auth" }, 401, requestId);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return noStoreJson({ error: "invalid_catalog" }, 400, requestId);
  }
  const result = await syncSessionCatalog({
    store: createPostgresSessionCatalogStore(database),
    installationId: auth.installationId,
    body: parsed
  });
  if (result.kind === "invalid") return noStoreJson({ error: "invalid_catalog" }, 400, requestId);
  scheduleAfterResponse(async () => {
    try {
      const slack = await createDefaultRemoteCodexSlackService(createRemoteCodexSlackRateLimiter(database));
      await publishBoundSessionStatuses({
        database,
        slack,
        installationId: auth.installationId,
        requestId
      });
    } catch {
      // Catalog persistence is authoritative. A later sync retries Slack status projection.
    }
  });
  return noStoreJson({ status: "synced", count: result.count, bindingsUpdateScheduled: true }, 200, requestId);
}

function bearerToken(value: string | null): string | null {
  return value?.match(/^Bearer ([^\s]+)$/)?.[1] ?? null;
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}
