import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { getDelegatedDeliveryConfig } from "../../../../../../src/server/config";
import { createConfiguredCredentialCipher } from "../../../../../../src/server/credentials/factory";
import { database } from "../../../../../../src/server/db";
import { executeDelegatedSlackMessage } from "../../../../../../src/server/delegated-delivery/execution";
import { delegatedErrorResponse, delegatedJsonResponse } from "../../../../../../src/server/delegated-delivery/http";
import { createPostgresDelegatedDeliveryStore } from "../../../../../../src/server/delegated-delivery/postgres-store";
import { createConfiguredSlackOAuthClient } from "../../../../../../src/server/slack/app-configuration-factory";
import { createSlackForwardingCredentialProvider } from "../../../../../../src/server/slack/forwarding-credentials";
import { createPostgresRefreshStore } from "../../../../../../src/server/slack/postgres-store";
import { createDefaultSlackWebApiClient } from "../../../../../../src/server/slack/web-api-client";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const correlationId = randomUUID();
  try {
    const config = getDelegatedDeliveryConfig();
    if (!config.enabled) return delegatedErrorResponse({ kind: "error", status: 404, error: "feature_disabled" }, correlationId);
    if (
      new URL(request.url).search.length > 0 ||
      request.headers.has("prism-client-proof") ||
      request.headers.has("content-type") ||
      (request.headers.get("content-length") !== null && request.headers.get("content-length") !== "0")
    ) return delegatedErrorResponse({ kind: "error", status: 400, error: "invalid_request" }, correlationId);
    const authorization = request.headers.get("authorization");
    const dpop = request.headers.get("dpop");
    const grantToken = authorization?.startsWith("DPoP ") ? authorization.slice(5).trim() : null;
    if (!grantToken || authorization?.includes(",")) {
      return delegatedErrorResponse({ kind: "error", status: 401, error: "invalid_grant" }, correlationId);
    }
    if (!dpop || dpop.includes(",")) {
      return delegatedErrorResponse({ kind: "error", status: 401, error: "invalid_dpop_proof" }, correlationId);
    }
    const cipher = createConfiguredCredentialCipher();
    const decision = await executeDelegatedSlackMessage({
      grantToken,
      dpopProof: dpop,
      store: createPostgresDelegatedDeliveryStore(database),
      cipher,
      credentialProvider: createSlackForwardingCredentialProvider({
        store: createPostgresRefreshStore(database),
        cipher,
        slackOAuthClient: await createConfiguredSlackOAuthClient({ database })
      }),
      slackClient: createDefaultSlackWebApiClient(),
      config
    });
    return decision.kind === "success"
      ? delegatedJsonResponse(decision.body, 200, correlationId)
      : delegatedErrorResponse(decision, correlationId);
  } catch {
    return delegatedErrorResponse({ kind: "error", status: 500, error: "server_error" }, correlationId);
  }
}
