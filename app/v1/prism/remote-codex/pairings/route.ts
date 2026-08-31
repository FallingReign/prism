import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getCredentialEncryptionConfig, getRemoteCodexConfig, isSetupRequiredError } from "../../../../../src/server/config";
import { database } from "../../../../../src/server/db";
import { createPairing } from "../../../../../src/server/remote-codex/pairing-service";
import { createPostgresPairingStore } from "../../../../../src/server/remote-codex/postgres-store";
import { remoteCodexSourceKey, resolveRemoteCodexPairingSource } from "../../../../../src/server/remote-codex/request-source";

export const dynamic = "force-dynamic";
const maxPairingBytes = 16 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const body = await readPairingBody(request);
    if (!body) return noStoreJson({ error: "invalid_pairing_request" }, 400, requestId);
    const config = getRemoteCodexConfig();
    if (!config.enabled) return noStoreJson({ error: "not_found" }, 404, requestId);
    const sourceIdentifier = resolveRemoteCodexPairingSource(request.headers, config.trustProxyHeaders);
    if (!sourceIdentifier) return noStoreJson({ error: "invalid_pairing_request" }, 400, requestId);
    const created = await createPairing({
      store: createPostgresPairingStore(database),
      publicBaseUrl: config.publicBaseUrl,
      sourceIdentifier,
      sourceKey: remoteCodexSourceKey(sourceIdentifier, getCredentialEncryptionConfig().key),
      ...body
    });
    return noStoreJson(created, 201, requestId);
  } catch (error) {
    if (isSetupRequiredError(error)) return noStoreJson({ error: "setup_required" }, 503, requestId);
    if (error instanceof Error && error.message.startsWith("invalid-")) {
      return noStoreJson({ error: "invalid_pairing_request" }, 400, requestId);
    }
    if (error instanceof Error && (error.message === "pairing-rate-limit" || error.message === "pairing-capacity")) {
      const limited = noStoreJson({ error: "pairing_temporarily_unavailable" }, 429, requestId);
      limited.headers.set("Retry-After", "60");
      return limited;
    }
    throw error;
  }
}

async function readPairingBody(request: NextRequest): Promise<
  | { signingPublicKey: string; encryptionPublicKey: string; machineLabel: string; companionVersion: string }
  | null
> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > maxPairingBytes) return null;
    const text = await request.text();
    if (Buffer.byteLength(text) > maxPairingBytes) return null;
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || Object.keys(body).sort().join(",") !== "companionVersion,encryptionPublicKey,machineLabel,signingPublicKey") return null;
    const { signingPublicKey, encryptionPublicKey, machineLabel, companionVersion } = body;
    if (![signingPublicKey, encryptionPublicKey, machineLabel, companionVersion].every((value) => typeof value === "string")) return null;
    return {
      signingPublicKey: signingPublicKey as string,
      encryptionPublicKey: encryptionPublicKey as string,
      machineLabel: machineLabel as string,
      companionVersion: companionVersion as string
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}
