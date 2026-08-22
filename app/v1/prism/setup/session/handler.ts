import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOriginBrowserMutation } from "../../../../../src/server/http/browser-mutation-csrf";
import {
  resolveDelegatedDeliverySource,
  UNATTRIBUTED_DELEGATED_SOURCE
} from "../../../../../src/server/delegated-delivery/request-source";
import { getSlackOAuthDeploymentConfig } from "../../../../../src/server/config";

export const setupSessionCookieName = "prism_setup_session";

export type SetupSessionExchange = {
  trustProxyHeaders?: boolean;
  exchangeCapability(input: {
    code: string;
    requestId: string;
    sourceAddress?: string;
  }): Promise<{ sessionToken: string; expiresAt: Date } | null>;
};

const MAX_BODY_BYTES = 4096;
const MAX_SETUP_SESSION_SECONDS = 30 * 60;

export async function handleSetupSessionPost(request: NextRequest, dependencies: SetupSessionExchange): Promise<NextResponse> {
  if (request.nextUrl.search.length > 0) {
    return secure(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
  }
  const csrf = rejectCrossOriginBrowserMutation(request);
  if (csrf) return secure(csrf);
  const resolvedSource = resolveDelegatedDeliverySource(
    request.headers,
    dependencies.trustProxyHeaders === true
  );
  if (resolvedSource === null) {
    return secure(NextResponse.json({ error: "invalid_request_source" }, { status: 400 }));
  }
  const sourceAddress =
    resolvedSource === UNATTRIBUTED_DELEGATED_SOURCE ? undefined : resolvedSource;
  const secureSetupCookie = getSlackOAuthDeploymentConfig().publicBaseUrl.startsWith("https://");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return secure(NextResponse.json({ error: "unsupported_media_type" }, { status: 415 }));
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return secure(NextResponse.json({ error: "request_too_large" }, { status: 413 }));

  const raw = await readBoundedText(request, MAX_BODY_BYTES);
  if (raw === null) return secure(NextResponse.json({ error: "request_too_large" }, { status: 413 }));
  const form = new URLSearchParams(raw);
  const keys = [...form.keys()];
  if (keys.length !== 1 || keys[0] !== "setupCode" || form.getAll("setupCode").length !== 1) return invalid(request);
  const code = form.get("setupCode") ?? "";
  if (code.length < 32 || code.length > 512) return invalid(request);

  let exchanged;
  try {
    exchanged = await dependencies.exchangeCapability({ code, requestId: randomUUID(), sourceAddress });
  } catch (error) {
    const retryAfter = rateLimitSeconds(error);
    if (retryAfter === null) throw error;
    const url = new URL("/setup", request.url);
    url.searchParams.set("error", "rate_limited");
    const response = NextResponse.redirect(url, 303);
    response.headers.set("Retry-After", String(retryAfter));
    return secure(response);
  }
  if (!exchanged) return invalid(request);

  const response = NextResponse.redirect(new URL("/setup", request.url), 303);
  const remainingSeconds = Math.max(1, Math.floor((exchanged.expiresAt.getTime() - Date.now()) / 1000));
  response.cookies.set(setupSessionCookieName, exchanged.sessionToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: secureSetupCookie,
    path: "/",
    maxAge: Math.min(MAX_SETUP_SESSION_SECONDS, remainingSeconds)
  });
  return secure(response);
}

function invalid(request: NextRequest): NextResponse {
  return secure(NextResponse.redirect(new URL("/setup?error=invalid_or_expired", request.url), 303));
}

export function secure(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  if (!response.headers.has("X-Prism-Request-ID")) response.headers.set("X-Prism-Request-ID", randomUUID());
  return response;
}

function rateLimitSeconds(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("retryAfterSeconds" in error)) return null;
  const value = Number(error.retryAfterSeconds);
  return Number.isInteger(value) && value >= 1 && value <= 3600 ? value : null;
}

export async function readBoundedText(request: NextRequest, maximumBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return null;
  }
}
