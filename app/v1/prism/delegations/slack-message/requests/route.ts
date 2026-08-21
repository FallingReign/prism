import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { getDelegatedDeliveryConfig } from "../../../../../../src/server/config";
import { createConfiguredCredentialCipher } from "../../../../../../src/server/credentials/factory";
import { database } from "../../../../../../src/server/db";
import { delegatedErrorResponse, delegatedJsonResponse, readBoundedUtf8Body } from "../../../../../../src/server/delegated-delivery/http";
import { createPostgresDelegatedDeliveryStore } from "../../../../../../src/server/delegated-delivery/postgres-store";
import { resolveDelegatedDeliverySource } from "../../../../../../src/server/delegated-delivery/request-source";
import { createDelegationRequest } from "../../../../../../src/server/delegated-delivery/service";

export const dynamic = "force-dynamic";
const MAX_JSON_BYTES = 512 * 1024;

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
      mediaType(request.headers.get("content-type")) !== "application/json" ||
      invalidDeclaredLength(request.headers.get("content-length"), MAX_JSON_BYTES)
    ) {
      return delegatedErrorResponse({ kind: "error", status: 400, error: "invalid_request" }, correlationId);
    }
    const proof = request.headers.get("prism-client-proof");
    if (!proof || proof.includes(",")) {
      return delegatedErrorResponse({ kind: "error", status: 401, error: "invalid_client_proof" }, correlationId);
    }
    const sourceIdentifier = resolveDelegatedDeliverySource(
      request.headers,
      config.trustProxyHeaders
    );
    if (sourceIdentifier === null) {
      return delegatedErrorResponse({ kind: "error", status: 400, error: "invalid_request" }, correlationId);
    }
    const rawBody = await readBoundedUtf8Body(request, MAX_JSON_BYTES);
    if (rawBody === null) {
      return delegatedErrorResponse({ kind: "error", status: 400, error: "invalid_request" }, correlationId);
    }
    const decision = await createDelegationRequest({
      rawBody,
      clientProof: proof,
      sourceIdentifier,
      store: createPostgresDelegatedDeliveryStore(database),
      cipher: createConfiguredCredentialCipher(),
      config
    });
    return decision.kind === "success"
      ? delegatedJsonResponse(decision.body, decision.status, correlationId)
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
