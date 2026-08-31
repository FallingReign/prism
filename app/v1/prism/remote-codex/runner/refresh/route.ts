import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getRemoteCodexConfig } from "@/src/server/config";
import { database } from "@/src/server/db";
import { rotateRunnerCredentials } from "@/src/server/remote-codex/credential-refresh";
import { createPostgresCredentialRefreshStore } from "@/src/server/remote-codex/runner-postgres-store";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (!getRemoteCodexConfig().enabled) return noStoreJson({ error: "not_found" }, 404, requestId);
  const body = await readBody(request);
  if (!body) return noStoreJson({ error: "invalid_refresh" }, 401, requestId);
  const result = await rotateRunnerCredentials({ store: createPostgresCredentialRefreshStore(database), ...body });
  if (result.kind !== "rotated") return noStoreJson({ error: "invalid_refresh" }, 401, requestId);
  return noStoreJson(
    {
      status: "rotated",
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt
    },
    200,
    requestId
  );
}

async function readBody(
  request: NextRequest
): Promise<{ installationId: string; refreshToken: string; proof: string } | null> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) return null;
    const { installationId, refreshToken, proof } = body;
    if (![installationId, refreshToken, proof].every((value) => typeof value === "string")) return null;
    return { installationId: installationId as string, refreshToken: refreshToken as string, proof: proof as string };
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
