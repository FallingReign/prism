import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import {
  clearSetupBrowserTransaction,
  hasSafeSetupNavigationMetadata,
  rejectUnprovenSetupBrowserMutation,
  type SetupBrowserMutationProof
} from "../../../../../../src/server/setup/browser-transaction-http";
import type { CookieSpec } from "../../../../../../src/server/slack/oauth-flow";
import { getSlackOAuthDeploymentConfig } from "../../../../../../src/server/config";
import { isFormUrlEncodedContentType, readBoundedText, setupSessionCookieName, secure } from "../../session/handler";

export type SetupVerificationDependencies = SetupBrowserMutationProof & {
  startVerification(input: { setupSessionToken: string; requestId: string }): Promise<{ redirectUrl: string; cookie: CookieSpec } | null>;
};

export async function handleSlackConfigurationVerifyPost(request: NextRequest, dependencies: SetupVerificationDependencies): Promise<NextResponse> {
  const jsonMode = request.headers.get("accept") === "application/json";
  const finish = (response: NextResponse) => clearSetupBrowserTransaction(secure(response), dependencies.secureBrowserTransactionCookie === true);
  const setupOrigin = dependencies.expectedOrigin ?? new URL(getSlackOAuthDeploymentConfig().publicBaseUrl).origin;
  if ([...request.nextUrl.searchParams.keys()].length > 0) return finish(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
  if (!isFormUrlEncodedContentType(request.headers.get("content-type"))) return finish(NextResponse.json({ error: "unsupported_media_type" }, { status: 415 }));
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 1024) return finish(NextResponse.json({ error: "request_too_large" }, { status: 413 }));
  const raw = await readBoundedText(request, 1024);
  if (raw === null) return finish(NextResponse.json({ error: "request_too_large" }, { status: 413 }));
  const form = new URLSearchParams(raw);
  const keys = [...form.keys()];
  if (keys.length !== 1 || keys[0] !== "setupProof" || form.getAll("setupProof").length !== 1) return finish(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
  const proof = form.get("setupProof") ?? "";
  if (proof.length < 64 || proof.length > 512) return finish(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
  const csrf = rejectUnprovenSetupBrowserMutation(request, dependencies, proof);
  if (csrf) return finish(hasSafeSetupNavigationMetadata(request, setupOrigin) ? setupError(setupOrigin, "secure_form_expired", jsonMode) : csrf);

  const setupSessionToken = request.cookies.get(setupSessionCookieName)?.value;
  if (!setupSessionToken) return finish(setupError(setupOrigin, "session_expired", jsonMode));
  const start = await dependencies.startVerification({ setupSessionToken, requestId: randomUUID() });
  if (!start || !isSlackAuthorizationUrl(start.redirectUrl)) return finish(setupError(setupOrigin, "verification_unavailable", jsonMode));

  const response = jsonMode
    ? NextResponse.json({ redirectUrl: start.redirectUrl })
    : NextResponse.redirect(start.redirectUrl, 303);
  response.headers.set("Vary", "Accept");
  response.cookies.set(start.cookie.name, start.cookie.value, {
    httpOnly: start.cookie.httpOnly,
    sameSite: start.cookie.sameSite,
    secure: start.cookie.secure,
    path: start.cookie.path,
    maxAge: start.cookie.maxAge
  });
  return finish(response);
}

function setupError(setupOrigin: string, error: "session_expired" | "verification_unavailable" | "secure_form_expired", jsonMode: boolean): NextResponse {
  if (jsonMode) {
    const response = NextResponse.json({ error }, { status: error === "session_expired" ? 401 : error === "secure_form_expired" ? 403 : 503 });
    response.headers.set("Vary", "Accept");
    return secure(response);
  }
  const url = new URL("/setup", setupOrigin);
  url.searchParams.set("error", error);
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Vary", "Accept");
  return secure(response);
}

function isSlackAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://slack.com" &&
      url.pathname === "/oauth/v2/authorize" &&
      !url.username &&
      !url.password &&
      !url.hash;
  } catch {
    return false;
  }
}
