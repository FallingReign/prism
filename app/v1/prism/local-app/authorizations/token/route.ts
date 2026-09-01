import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getDeveloperTokenConfig } from "../../../../../../src/server/config";
import { database } from "../../../../../../src/server/db";
import { hasDuplicateJsonObjectKeys } from "../../../../../../src/server/http/json-shape";
import { localAppJsonResponse, readBoundedUtf8Body } from "../../../../../../src/server/local-app-authorization/http";
import { createPostgresLocalAppAuthorizationStore } from "../../../../../../src/server/local-app-authorization/postgres-store";
import { resolveLocalAppRequestSource } from "../../../../../../src/server/local-app-authorization/request-source";
import { pollLocalAppAuthorization } from "../../../../../../src/server/local-app-authorization/service";
import { parseTokenInput } from "../../../../../../src/server/local-app-authorization/validation";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.nextUrl.search || request.headers.has("authorization") || request.headers.get("content-type") !== "application/json") {
    return localAppJsonResponse({ error: "invalid_request" }, 400, requestId);
  }
  const body = await readBoundedUtf8Body(request, 2_048);
  if (body === null) return localAppJsonResponse({ error: "invalid_request" }, 400, requestId);
  let parsed: unknown;
  try {
    if (hasDuplicateJsonObjectKeys(body)) return localAppJsonResponse({ error: "invalid_request" }, 400, requestId);
    parsed = JSON.parse(body);
  } catch {
    return localAppJsonResponse({ error: "invalid_request" }, 400, requestId);
  }
  const input = parseTokenInput(parsed);
  if (!input) return localAppJsonResponse({ error: "invalid_request" }, 400, requestId);

  try {
    const result = await pollLocalAppAuthorization({
      store: createPostgresLocalAppAuthorizationStore(database),
      clientId: input.clientId,
      deviceCode: input.deviceCode,
      developerTokenConfig: getDeveloperTokenConfig(),
      auditRequestId: requestId,
      sourceIdentifier: resolveLocalAppRequestSource(request.headers)
    });
    if (result.kind === "pending") return localAppJsonResponse({ error: "authorization_pending" }, 202, requestId);
    if (result.kind === "slow_down") {
      const response = localAppJsonResponse({ error: "slow_down", retryAfterSeconds: result.retryAfterSeconds }, 429, requestId);
      response.headers.set("Retry-After", String(result.retryAfterSeconds));
      return response;
    }
    if (result.kind === "rate_limited") {
      const response = localAppJsonResponse({ error: "rate_limited", retryAfterSeconds: result.retryAfterSeconds }, 429, requestId);
      response.headers.set("Retry-After", String(result.retryAfterSeconds));
      return response;
    }
    if (result.kind !== "issued") {
      if (result.kind === "policy_denied") return localAppJsonResponse({ error: "policy_denied" }, 403, requestId);
      if (result.kind === "denied") return localAppJsonResponse({ error: "access_denied" }, 400, requestId);
      if (result.kind === "expired") return localAppJsonResponse({ error: "expired_token" }, 400, requestId);
      return localAppJsonResponse({ error: "invalid_grant" }, 400, requestId);
    }
    return localAppJsonResponse({
      tokenType: "Bearer",
      developerToken: result.developerToken,
      tokenProfileId: result.tokenProfileId,
      clientId: result.clientId,
      subject: {
        prismUserId: result.subject.prismUserId,
        installationScope: result.subject.installationScope,
        slackTeamId: result.subject.slackTeamId,
        slackEnterpriseId: result.subject.slackEnterpriseId,
        workspaces: result.subject.workspaces.map((workspace) => ({
          teamId: workspace.teamId,
          teamName: workspace.teamName
        }))
      }
    }, 200, requestId);
  } catch {
    return localAppJsonResponse({ error: "service_unavailable" }, 503, requestId);
  }
}
