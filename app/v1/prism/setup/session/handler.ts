import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import {
  resolveDelegatedDeliverySource,
  UNATTRIBUTED_DELEGATED_SOURCE
} from "../../../../../src/server/delegated-delivery/request-source";
import { getSlackOAuthDeploymentConfig } from "../../../../../src/server/config";
import {
  clearSetupBrowserTransaction,
  hasSafeSetupNavigationMetadata,
  rejectUnprovenSetupBrowserMutation,
  type SetupBrowserMutationProof
} from "../../../../../src/server/setup/browser-transaction-http";

export const setupSessionCookieName = "prism_setup_session";

export type SetupSessionExchange = SetupBrowserMutationProof & {
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
  const finish = (response: NextResponse) => clearBrowserTransaction(secure(response), dependencies.secureBrowserTransactionCookie === true);
  const setupOrigin = dependencies.expectedOrigin ?? new URL(getSlackOAuthDeploymentConfig().publicBaseUrl).origin;
  const secureSetupCookie = getSlackOAuthDeploymentConfig().publicBaseUrl.startsWith("https://");
  if (!isFormUrlEncodedContentType(request.headers.get("content-type"))) {
    return finish(NextResponse.json({ error: "unsupported_media_type" }, { status: 415 }));
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return finish(NextResponse.json({ error: "request_too_large" }, { status: 413 }));

  const raw = await readBoundedText(request, MAX_BODY_BYTES);
  if (raw === null) return finish(NextResponse.json({ error: "request_too_large" }, { status: 413 }));
  const form = new URLSearchParams(raw);
  const keys = [...form.keys()];
  if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes("setupCode") || !keys.includes("setupProof") || form.getAll("setupCode").length !== 1 || form.getAll("setupProof").length !== 1) return finish(invalid(setupOrigin));
  const code = form.get("setupCode") ?? "";
  const proof = form.get("setupProof") ?? "";
  if (code.length < 32 || code.length > 512 || proof.length < 64 || proof.length > 512) return finish(invalid(setupOrigin));
  const csrf = rejectUnprovenSetupBrowserMutation(request, dependencies, proof);
  if (csrf) return finish(hasSafeSetupNavigationMetadata(request, setupOrigin) ? setupRedirect(setupOrigin, "secure_form_expired") : csrf);
  const resolvedSource = resolveDelegatedDeliverySource(
    request.headers,
    dependencies.trustProxyHeaders === true
  );
  if (resolvedSource === null) {
    return finish(NextResponse.json({ error: "invalid_request_source" }, { status: 400 }));
  }
  const sourceAddress =
    resolvedSource === UNATTRIBUTED_DELEGATED_SOURCE ? undefined : resolvedSource;

  let exchanged;
  try {
    exchanged = await dependencies.exchangeCapability({ code, requestId: randomUUID(), sourceAddress });
  } catch (error) {
    const retryAfter = rateLimitSeconds(error);
    if (retryAfter === null) throw error;
    const url = new URL("/setup", setupOrigin);
    url.searchParams.set("error", "rate_limited");
    const response = NextResponse.redirect(url, 303);
    response.headers.set("Retry-After", String(retryAfter));
    return finish(response);
  }
  if (!exchanged) return finish(invalid(setupOrigin));

  const response = NextResponse.redirect(new URL("/setup", setupOrigin), 303);
  const remainingSeconds = Math.max(1, Math.floor((exchanged.expiresAt.getTime() - Date.now()) / 1000));
  response.cookies.set(setupSessionCookieName, exchanged.sessionToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: secureSetupCookie,
    path: "/",
    maxAge: Math.min(MAX_SETUP_SESSION_SECONDS, remainingSeconds)
  });
  return finish(response);
}

function invalid(setupOrigin: string): NextResponse {
  return secure(NextResponse.redirect(new URL("/setup?error=invalid_or_expired", setupOrigin), 303));
}

function setupRedirect(setupOrigin: string, error: string): NextResponse {
  const url = new URL("/setup", setupOrigin);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

export function secure(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  if (!response.headers.has("X-Prism-Request-ID")) response.headers.set("X-Prism-Request-ID", randomUUID());
  return response;
}

function clearBrowserTransaction(response: NextResponse, secureCookie: boolean): NextResponse {
  return clearSetupBrowserTransaction(response, secureCookie);
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

export function isFormUrlEncodedContentType(value: string | null): boolean {
  if (value === null || value.length > 1024) return false;
  const parameterStart = value.indexOf(";");
  const essence = (parameterStart === -1 ? value : value.slice(0, parameterStart)).trim().toLowerCase();
  return essence === "application/x-www-form-urlencoded";
}
