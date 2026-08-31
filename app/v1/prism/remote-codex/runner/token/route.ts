import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getRemoteCodexConfig } from "../../../../../../src/server/config";
import { database } from "../../../../../../src/server/db";
import { exchangePairing } from "../../../../../../src/server/remote-codex/pairing-service";
import { createPostgresPairingStore } from "../../../../../../src/server/remote-codex/postgres-store";

export const dynamic = "force-dynamic";
const maxTokenBytes = 16 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (!getRemoteCodexConfig().enabled) return noStoreJson({ error: "not_found" }, 404, requestId);
  const body = await readTokenBody(request);
  if (!body) return noStoreJson({ error: "invalid_pairing" }, 401, requestId);

  const result = await exchangePairing({ store: createPostgresPairingStore(database), ...body });
  if (result.kind === "pending") return noStoreJson({ status: "pending" }, 202, requestId);
  if (result.kind !== "connected") return noStoreJson({ error: "invalid_pairing" }, 401, requestId);
  return noStoreJson(
    {
      status: "connected",
      installationId: result.installationId,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt
    },
    200,
    requestId
  );
}

async function readTokenBody(
  request: NextRequest
): Promise<{ pairingId: string; oneTimeSecret: string; proof: string } | null> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > maxTokenBytes) return null;
    const text = await request.text();
    if (Buffer.byteLength(text) > maxTokenBytes) return null;
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || Object.keys(body).sort().join(",") !== "oneTimeSecret,pairingId,proof") return null;
    const { pairingId, oneTimeSecret, proof } = body;
    if (![pairingId, oneTimeSecret, proof].every((value) => typeof value === "string")) return null;
    return { pairingId: pairingId as string, oneTimeSecret: oneTimeSecret as string, proof: proof as string };
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
