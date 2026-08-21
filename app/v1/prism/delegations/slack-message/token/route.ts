import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { getDelegatedDeliveryConfig } from "../../../../../../src/server/config";
import { database } from "../../../../../../src/server/db";
import { delegatedErrorResponse, delegatedJsonResponse, readBoundedUtf8Body } from "../../../../../../src/server/delegated-delivery/http";
import { createPostgresDelegatedDeliveryStore } from "../../../../../../src/server/delegated-delivery/postgres-store";
import { exchangeDelegatedAuthorizationCode } from "../../../../../../src/server/delegated-delivery/service";

export const dynamic = "force-dynamic";
const MAX_FORM_BYTES = 16 * 1024;

export async function POST(request: NextRequest) {
  const correlationId = randomUUID();
  try {
    const config = getDelegatedDeliveryConfig();
    if (!config.enabled) {
      return delegatedErrorResponse({ kind: "error", status: 404, error: "feature_disabled" }, correlationId);
    }
    if (
      new URL(request.url).search.length > 0 ||
      request.headers.has("authorization") ||
      request.headers.has("prism-client-proof") ||
      mediaType(request.headers.get("content-type")) !== "application/x-www-form-urlencoded" ||
      invalidDeclaredLength(request.headers.get("content-length"), MAX_FORM_BYTES)
    ) {
      return delegatedErrorResponse({ kind: "error", status: 400, error: "invalid_request" }, correlationId);
    }
    const dpop = request.headers.get("dpop");
    if (!dpop || dpop.includes(",")) {
      return delegatedErrorResponse({ kind: "error", status: 401, error: "invalid_dpop_proof" }, correlationId);
    }
    const body = await readBoundedUtf8Body(request, MAX_FORM_BYTES);
    if (body === null) {
      return delegatedErrorResponse({ kind: "error", status: 400, error: "invalid_request" }, correlationId);
    }
    const decision = await exchangeDelegatedAuthorizationCode({
      params: new URLSearchParams(body),
      dpopProof: dpop,
      store: createPostgresDelegatedDeliveryStore(database),
      config
    });
    return decision.kind === "success"
      ? delegatedJsonResponse(decision.body, 200, correlationId)
      : delegatedErrorResponse(decision, correlationId);
  } catch {
    return delegatedErrorResponse({ kind: "error", status: 500, error: "server_error" }, correlationId);
  }
}

function mediaType(value: string | null): string | null {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function invalidDeclaredLength(value: string | null, maximum: number): boolean {
  if (value === null) return false;
  if (!/^\d+$/.test(value)) return true;
  const length = Number(value);
  return !Number.isSafeInteger(length) || length < 0 || length > maximum;
}
