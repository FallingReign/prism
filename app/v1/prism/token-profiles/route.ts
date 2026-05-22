import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { createPostgresActivityAuditStore, isActivityAuditUnavailableError } from "../../../../src/server/audit/postgres-store";
import { getDeveloperTokenConfig, isSetupRequiredError } from "../../../../src/server/config";
import { database } from "../../../../src/server/db";
import { prismSessionCookieName } from "../../../../src/server/slack/oauth-flow";
import { createTokenProfile, listTokenProfiles, type CreateTokenProfileInput } from "../../../../src/server/token-profiles/service";
import { createPostgresTokenProfileStore } from "../../../../src/server/token-profiles/store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const store = createPostgresTokenProfileStore(database);
  const result = await listTokenProfiles({
    store,
    sessionToken: request.cookies.get(prismSessionCookieName)?.value
  });
  if (result.kind !== "profiles") {
    return noStoreJson({ error: result.kind }, 401, requestId);
  }
  await createPostgresActivityAuditStore(database).recordActivity({
    prismUserId: result.owner.prismUserId,
    slackConnectionId: result.owner.slackConnectionId,
    activityType: "token_profiles_listed",
    endpoint: new URL(request.url).pathname,
    status: "listed",
    httpStatus: 200,
    requestId,
    upstreamCalled: false
  });
  return noStoreJson({ profiles: result.profiles, slackStatus: result.slackStatus }, 200, requestId);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const input = await readCreateInput(request);
  if (!input) return noStoreJson({ error: "invalid_json" }, 400, requestId);

  try {
    const result = await createTokenProfile({
      store: createPostgresTokenProfileStore(database),
      sessionToken: request.cookies.get(prismSessionCookieName)?.value,
      developerTokenConfig: getDeveloperTokenConfig(),
      input,
      audit: { endpoint: new URL(request.url).pathname, requestId }
    });

    if (result.kind === "created") {
      return noStoreJson(
        {
          profile: result.profile,
          developerToken: result.developerToken,
          slackStatus: result.slackStatus
        },
        201,
        requestId
      );
    }
    if (result.kind === "validation_error") return noStoreJson({ error: result.kind, message: result.message }, 400, requestId);
    if (result.kind === "duplicate_name") return noStoreJson({ error: result.kind }, 409, requestId);
    return noStoreJson({ error: result.kind }, 401, requestId);
  } catch (error) {
    if (isSetupRequiredError(error)) return noStoreJson({ error: "setup_required" }, 503, requestId);
    if (isActivityAuditUnavailableError(error)) return noStoreJson({ error: "audit_unavailable" }, 503, requestId);
    throw error;
  }
}

async function readCreateInput(request: NextRequest): Promise<CreateTokenProfileInput | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  const custom = isRecord(body.custom) ? body.custom : undefined;
  return {
    name: stringValue(body.name),
    intendedUse: stringValue(body.intendedUse),
    preset: stringValue(body.preset) as CreateTokenProfileInput["preset"],
    executionIdentity: stringValue(body.executionIdentity) as CreateTokenProfileInput["executionIdentity"],
    destructive: booleanValue(body.destructive),
    experiment: stringValue(body.experiment) as CreateTokenProfileInput["experiment"],
    custom: custom
      ? {
          read: booleanValue(custom.read),
          search: booleanValue(custom.search),
          writeMessages: booleanValue(custom.writeMessages),
          reactions: booleanValue(custom.reactions),
          filesMetadata: booleanValue(custom.filesMetadata),
          destructive: booleanValue(custom.destructive)
        }
      : undefined
  };
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
