import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getRemoteCodexConfig } from "@/src/server/config";
import { database } from "@/src/server/db";
import { createPostgresBindingStore } from "@/src/server/remote-codex/binding-postgres-store";
import { createRemoteCodexBindingService } from "@/src/server/remote-codex/binding-service";
import { createDefaultRemoteCodexSlackService } from "@/src/server/remote-codex/internal-slack-service";
import { verifyRunnerRequest } from "@/src/server/remote-codex/runner-auth";
import { createPostgresRunnerAuthStore } from "@/src/server/remote-codex/runner-postgres-store";
import { createRemoteCodexSlackRateLimiter } from "@/src/server/remote-codex/slack-rate-limit";

export const dynamic = "force-dynamic";
const maxBodyBytes = 8 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (!getRemoteCodexConfig().enabled) return response({ error: "not_found" }, 404, requestId);
  const body = await request.text();
  if (Buffer.byteLength(body) > maxBodyBytes) return response({ error: "invalid_request" }, 400, requestId);
  const accessToken = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1];
  const installationId = request.headers.get("x-prism-installation-id");
  const timestamp = request.headers.get("x-prism-timestamp");
  const nonce = request.headers.get("x-prism-nonce");
  const signature = request.headers.get("x-prism-signature");
  if (!accessToken || !installationId || !timestamp || !nonce || !signature) return response({ error: "invalid_runner_auth" }, 401, requestId);
  const auth = await verifyRunnerRequest({
    store: createPostgresRunnerAuthStore(database), method: request.method, path: new URL(request.url).pathname,
    body, installationId, accessToken, timestamp, nonce, signature
  });
  if (auth.kind !== "authenticated") return response({ error: "invalid_runner_auth" }, 401, requestId);
  const parsed = parseShareBody(body);
  if (!parsed) return response({ error: "invalid_request" }, 400, requestId);
  const binding = createRemoteCodexBindingService({
    store: createPostgresBindingStore(database),
    slack: await createDefaultRemoteCodexSlackService(createRemoteCodexSlackRateLimiter(database))
  });
  const result = await binding.attach({
    source: "runner", prismUserId: auth.prismUserId, slackConnectionId: auth.slackConnectionId,
    installationId: auth.installationId, threadId: parsed.threadId, requestId
  });
  if (result.kind === "not_found") return response({ error: "session_not_found" }, 404, requestId);
  if (result.kind === "unavailable") return response({ error: "slack_unavailable" }, 503, requestId);
  if (result.kind === "pending") return response({ status: "pending" }, 202, requestId);
  return response({ status: "attached", permalink: result.permalink, existing: result.existing }, 200, requestId);
}

function parseShareBody(body: string): { threadId: string } | null {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).join(",") !== "threadId") return null;
    const threadId = (value as { threadId?: unknown }).threadId;
    return typeof threadId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(threadId) ? { threadId } : null;
  } catch { return null; }
}
function response(body: unknown, status: number, requestId: string): NextResponse {
  const result = NextResponse.json(body, { status }); result.headers.set("Cache-Control", "no-store"); result.headers.set("X-Prism-Request-ID", requestId); return result;
}
