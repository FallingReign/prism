import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getDeveloperTokenConfig, isSetupRequiredError } from "../../../../src/server/config";
import { database } from "../../../../src/server/db";
import { getPrismTokenStatus } from "../../../../src/server/token-profiles/local-tool-status";
import { createPostgresTokenProfileStore } from "../../../../src/server/token-profiles/store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const result = await getPrismTokenStatus({
      store: createPostgresTokenProfileStore(database),
      bearerToken: readBearerToken(request.headers.get("authorization")),
      developerTokenConfig: getDeveloperTokenConfig(),
      requestId
    });
    return noStoreJson(result.body, result.httpStatus, requestId);
  } catch (error) {
    if (isSetupRequiredError(error)) return noStoreJson({ requestId, error: "setup_required" }, 503, requestId);
    throw error;
  }
}

function readBearerToken(authorization: string | null): string | undefined {
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}
