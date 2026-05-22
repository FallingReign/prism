import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { isActivityAuditUnavailableError } from "../../../../../../src/server/audit/postgres-store";
import { getDeveloperTokenConfig, isSetupRequiredError } from "../../../../../../src/server/config";
import { database } from "../../../../../../src/server/db";
import { prismSessionCookieName } from "../../../../../../src/server/slack/oauth-flow";
import { updateTokenProfilePolicy, type CreateTokenProfileInput } from "../../../../../../src/server/token-profiles/service";
import { createPostgresTokenProfileStore } from "../../../../../../src/server/token-profiles/store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ profileId: string }> | { profileId: string } };

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = randomUUID();
  const { profileId } = await context.params;
  const input = await readPolicyInput(request);
  if (!input) return noStoreJson({ error: "invalid_json" }, 400, requestId);

  try {
    const result = await updateTokenProfilePolicy({
      store: createPostgresTokenProfileStore(database),
      sessionToken: request.cookies.get(prismSessionCookieName)?.value,
      profileId,
      input: input.profile,
      confirmBroadening: input.confirmBroadening,
      developerTokenConfig: input.confirmBroadening ? getDeveloperTokenConfig() : undefined,
      audit: { endpoint: new URL(request.url).pathname, requestId }
    });
    if (result.kind === "updated") {
      return noStoreJson(
        {
          profile: result.profile,
          developerToken: result.developerToken,
          slackStatus: result.slackStatus,
          change: result.change
        },
        200,
        requestId
      );
    }
    if (result.kind === "rotation_required") {
      return noStoreJson({ error: result.kind, message: result.message, change: result.change }, 409, requestId);
    }
    if (result.kind === "validation_error") return noStoreJson({ error: result.kind, message: result.message }, 400, requestId);
    return noStoreJson({ error: result.kind }, result.kind === "not_found" ? 404 : 401, requestId);
  } catch (error) {
    if (isSetupRequiredError(error)) return noStoreJson({ error: "setup_required" }, 503, requestId);
    if (isActivityAuditUnavailableError(error)) return noStoreJson({ error: "audit_unavailable" }, 503, requestId);
    throw error;
  }
}

async function readPolicyInput(request: NextRequest): Promise<{ profile: CreateTokenProfileInput; confirmBroadening: boolean } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  const custom = isRecord(body.custom) ? body.custom : undefined;
  return {
    profile: {
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
    },
    confirmBroadening: body.confirmBroadening === true
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
