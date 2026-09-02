import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDeveloperTokenConfig } from "../config";
import { database } from "../db";
import { resolvePresentedDeveloperToken, type ResolvedDeveloperToken } from "../token-profiles/local-tool-status";
import { createPostgresTokenProfileStore } from "../token-profiles/store";

export async function authenticatePrismInboxRequest(request: NextRequest, requestId: string): Promise<
  | { kind: "authenticated"; resolved: ResolvedDeveloperToken; tokenStore: ReturnType<typeof createPostgresTokenProfileStore> }
  | { kind: "response"; response: NextResponse }
> {
  const tokenStore = createPostgresTokenProfileStore(database);
  const resolution = await resolvePresentedDeveloperToken({
    store: tokenStore,
    bearerToken: readBearerToken(request.headers.get("authorization")),
    developerTokenConfig: getDeveloperTokenConfig(),
    requestId,
    now: new Date()
  });
  if (resolution.kind === "result") {
    return { kind: "response", response: prismInboxJson({ ok: false, error: resolution.result.body.token.status, requestId }, resolution.result.httpStatus, requestId) };
  }
  if (resolution.resolved.capabilityMap.inbound?.blockActions !== true) {
    return {
      kind: "response",
      response: prismInboxJson({ ok: false, error: "inbound_not_allowed", requestId }, 403, requestId)
    };
  }
  return { kind: "authenticated", resolved: resolution.resolved, tokenStore };
}

export function prismInboxJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}

export function readJsonRecord(request: NextRequest): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!contentType.startsWith("application/json") || (Number.isFinite(declaredLength) && declaredLength > 8 * 1024)) {
    return Promise.resolve(null);
  }
  return request.text().then((raw) => {
    if (Buffer.byteLength(raw, "utf8") > 8 * 1024) return null;
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : null;
  }).catch(() => null);
}

function readBearerToken(authorization: string | null): string | undefined {
  return authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
