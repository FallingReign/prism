import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getRemoteCodexConfig, isSetupRequiredError } from "@/src/server/config";
import { database } from "@/src/server/db";
import { rejectCrossOriginBrowserMutation } from "@/src/server/http/browser-mutation-csrf";
import { approvePairing } from "@/src/server/remote-codex/pairing-service";
import { createPostgresPairingStore } from "@/src/server/remote-codex/postgres-store";
import { prismSessionCookieName } from "@/src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";
const maxApprovalBytes = 8 * 1024;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ pairingId: string }> }
): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const { pairingId } = await context.params;
    const csrfRejection = rejectCrossOriginBrowserMutation(request);
    if (csrfRejection) {
      csrfRejection.headers.set("X-Prism-Request-ID", requestId);
      return csrfRejection;
    }
    const sessionToken = request.cookies.get(prismSessionCookieName)?.value;
    const form = await readForm(request);
    const config = getRemoteCodexConfig();
    if (!config.enabled) return noStoreJson({ error: "not_found" }, 404, requestId);
    if (!sessionToken || !form) {
      return noStoreJson({ error: "invalid_browser_request" }, 403, requestId);
    }

    const result = await approvePairing({
      store: createPostgresPairingStore(database),
      pairingId,
      sessionToken,
      targetTeamId: form.teamId
    });
    if (result.kind === "approved") {
      const success = new URL(`/remote-codex/pair/${encodeURIComponent(pairingId)}`, config.publicBaseUrl);
      success.searchParams.set("connected", "1");
      const redirect = NextResponse.redirect(success, 303);
      redirect.headers.set("Cache-Control", "no-store");
      redirect.headers.set("X-Prism-Request-ID", requestId);
      return redirect;
    }
    if (result.kind === "unauthenticated") return noStoreJson({ error: "unauthenticated" }, 401, requestId);
    return noStoreJson({ error: "pairing_unavailable" }, 409, requestId);
  } catch (error) {
    if (isSetupRequiredError(error)) return noStoreJson({ error: "setup_required" }, 503, requestId);
    throw error;
  }
}

async function readForm(request: NextRequest): Promise<{ teamId: string } | null> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/x-www-form-urlencoded")) return null;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > maxApprovalBytes) return null;
    const text = await request.text();
    if (Buffer.byteLength(text) > maxApprovalBytes) return null;
    const form = new URLSearchParams(text);
    if ([...form.keys()].join(",") !== "teamId") return null;
    const teamId = form.get("teamId");
    if (!teamId) return null;
    return { teamId };
  } catch {
    return null;
  }
}

function noStoreJson(body: unknown, status: number, requestId: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}
