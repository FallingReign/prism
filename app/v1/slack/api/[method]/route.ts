import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getDeveloperTokenConfig, isSetupRequiredError } from "../../../../../src/server/config";
import { database } from "../../../../../src/server/db";
import { evaluateSlackMethodPolicy, type SlackSurface } from "../../../../../src/server/token-profiles/method-policy";
import { createPostgresTokenProfileStore } from "../../../../../src/server/token-profiles/store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ method: string }> | { method: string } };

const slackSurfaces = new Set<SlackSurface>(["public_channel", "private_channel", "dm", "mpim", "search", "files_metadata"]);

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handleSlackMethod(request, context);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handleSlackMethod(request, context);
}

async function handleSlackMethod(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = randomUUID();
  const { method } = await context.params;
  try {
    const decision = await evaluateSlackMethodPolicy({
      store: createPostgresTokenProfileStore(database),
      bearerToken: readBearerToken(request.headers.get("authorization")),
      developerTokenConfig: getDeveloperTokenConfig(),
      method,
      requestId,
      requestContext: {
        workspaceId: request.headers.get("x-prism-workspace-id") ?? undefined,
        surface: readSurface(request.headers.get("x-prism-surface"))
      }
    });
    if (decision.kind !== "allowed") return noStoreJson(decision.body, decision.httpStatus, requestId);

    return noStoreJson(
      {
        ok: false,
        error: "slack_forwarding_not_implemented",
        prism: {
          requestId,
          method: decision.method,
          category: decision.category,
          tokenProfileId: decision.tokenProfileId,
          policy: "allowed"
        }
      },
      501,
      requestId
    );
  } catch (error) {
    if (isSetupRequiredError(error)) return noStoreJson({ ok: false, error: "setup_required", prism: { requestId, method } }, 503, requestId);
    throw error;
  }
}

function readBearerToken(authorization: string | null): string | undefined {
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}

function readSurface(surface: string | null): SlackSurface | undefined {
  return surface && slackSurfaces.has(surface as SlackSurface) ? (surface as SlackSurface) : undefined;
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}
