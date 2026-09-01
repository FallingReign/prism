import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getSlackOAuthDeploymentConfig } from "../../../../../src/server/config";
import { database } from "../../../../../src/server/db";
import { hasDuplicateJsonObjectKeys } from "../../../../../src/server/http/json-shape";
import { localAppJsonResponse, readBoundedUtf8Body } from "../../../../../src/server/local-app-authorization/http";
import { createPostgresLocalAppAuthorizationStore } from "../../../../../src/server/local-app-authorization/postgres-store";
import { resolveLocalAppRequestSource } from "../../../../../src/server/local-app-authorization/request-source";
import { beginLocalAppAuthorization } from "../../../../../src/server/local-app-authorization/service";
import { parseBeginInput } from "../../../../../src/server/local-app-authorization/validation";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.nextUrl.search || request.headers.has("authorization") || request.headers.get("content-type") !== "application/json") {
    return localAppJsonResponse({ error: "invalid_request" }, 400, requestId);
  }
  const body = await readBoundedUtf8Body(request, 4_096);
  if (body === null) return localAppJsonResponse({ error: "invalid_request" }, 400, requestId);
  let parsed: unknown;
  try {
    if (hasDuplicateJsonObjectKeys(body)) return localAppJsonResponse({ error: "invalid_request" }, 400, requestId);
    parsed = JSON.parse(body);
  } catch {
    return localAppJsonResponse({ error: "invalid_request" }, 400, requestId);
  }
  const input = parseBeginInput(parsed);
  if (!input) return localAppJsonResponse({ error: "invalid_request" }, 400, requestId);

  try {
    const result = await beginLocalAppAuthorization({
      store: createPostgresLocalAppAuthorizationStore(database),
      request: input,
      publicBaseUrl: getSlackOAuthDeploymentConfig().publicBaseUrl,
      sourceIdentifier: resolveLocalAppRequestSource(request.headers)
    });
    if (result.kind === "rate_limited") {
      const response = localAppJsonResponse({ error: "rate_limited", retryAfterSeconds: 60 }, 429, requestId);
      response.headers.set("Retry-After", "60");
      return response;
    }
    return localAppJsonResponse({
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      verificationUri: result.verificationUri,
      verificationUriComplete: result.verificationUriComplete,
      expiresAt: result.expiresAt.toISOString(),
      intervalSeconds: result.intervalSeconds
    }, 201, requestId);
  } catch {
    return localAppJsonResponse({ error: "service_unavailable" }, 503, requestId);
  }
}
