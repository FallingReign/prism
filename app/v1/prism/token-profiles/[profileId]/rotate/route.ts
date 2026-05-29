import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { isActivityAuditUnavailableError } from "../../../../../../src/server/audit/postgres-store";
import { getDeveloperTokenConfig, isSetupRequiredError } from "../../../../../../src/server/config";
import { database } from "../../../../../../src/server/db";
import { prismSessionCookieName } from "../../../../../../src/server/slack/oauth-flow";
import { createPostgresGlobalTokenProfilePolicyStore } from "../../../../../../src/server/token-profiles/global-policy-store";
import { rotateTokenProfile, type TokenRotationOverlap } from "../../../../../../src/server/token-profiles/service";
import { createPostgresTokenProfileStore } from "../../../../../../src/server/token-profiles/store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ profileId: string }> | { profileId: string } };

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = randomUUID();
  const { profileId } = await context.params;
  const input = await readRotateInput(request);
  if (!input) return noStoreJson({ error: "invalid_json" }, 400, requestId);

  try {
    const result = await rotateTokenProfile({
      store: createPostgresTokenProfileStore(database),
      globalPolicyStore: createPostgresGlobalTokenProfilePolicyStore(database),
      sessionToken: request.cookies.get(prismSessionCookieName)?.value,
      profileId,
      overlap: input.overlap,
      developerTokenConfig: getDeveloperTokenConfig(),
      audit: { endpoint: new URL(request.url).pathname, requestId }
    });
    if (result.kind === "rotated") {
      return noStoreJson({ profile: result.profile, developerToken: result.developerToken, slackStatus: result.slackStatus }, 200, requestId);
    }
    if (result.kind === "outside_global_policy") return noStoreJson({ error: result.kind, message: result.message, reasons: result.reasons }, 409, requestId);
    if (result.kind === "validation_error") return noStoreJson({ error: result.kind, message: result.message }, 400, requestId);
    return noStoreJson({ error: result.kind, message: result.message }, result.kind === "not_found" ? 404 : 401, requestId);
  } catch (error) {
    if (isSetupRequiredError(error)) return noStoreJson({ error: "setup_required" }, 503, requestId);
    if (isActivityAuditUnavailableError(error)) return noStoreJson({ error: "audit_unavailable" }, 503, requestId);
    throw error;
  }
}

async function readRotateInput(request: NextRequest): Promise<{ overlap: TokenRotationOverlap } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { overlap: "none" };
  }
  if (!isRecord(body)) return null;
  const overlap = typeof body.overlap === "string" ? body.overlap : "none";
  if (overlap === "none" || overlap === "15m" || overlap === "1h" || overlap === "24h") return { overlap };
  return null;
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
