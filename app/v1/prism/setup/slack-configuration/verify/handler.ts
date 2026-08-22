import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOriginBrowserMutation } from "../../../../../../src/server/http/browser-mutation-csrf";
import type { CookieSpec } from "../../../../../../src/server/slack/oauth-flow";
import { readBoundedText, setupSessionCookieName, secure } from "../../session/handler";

export type SetupVerificationDependencies = {
  startVerification(input: { setupSessionToken: string; requestId: string }): Promise<{ redirectUrl: string; cookie: CookieSpec } | null>;
};

export async function handleSlackConfigurationVerifyPost(request: NextRequest, dependencies: SetupVerificationDependencies): Promise<NextResponse> {
  const csrf = rejectCrossOriginBrowserMutation(request);
  if (csrf) return secure(csrf);
  if ([...request.nextUrl.searchParams.keys()].length > 0) return secure(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 1024) return secure(NextResponse.json({ error: "request_too_large" }, { status: 413 }));
  const raw = await readBoundedText(request, 1024);
  if (raw === null) return secure(NextResponse.json({ error: "request_too_large" }, { status: 413 }));
  if (raw.length > 0) return secure(NextResponse.json({ error: "invalid_request" }, { status: 400 }));

  const setupSessionToken = request.cookies.get(setupSessionCookieName)?.value;
  if (!setupSessionToken) return setupError(request, "session_expired");
  const start = await dependencies.startVerification({ setupSessionToken, requestId: randomUUID() });
  if (!start) return setupError(request, "verification_unavailable");

  const response = NextResponse.redirect(start.redirectUrl, 303);
  response.cookies.set(start.cookie.name, start.cookie.value, {
    httpOnly: start.cookie.httpOnly,
    sameSite: start.cookie.sameSite,
    secure: start.cookie.secure,
    path: start.cookie.path,
    maxAge: start.cookie.maxAge
  });
  return secure(response);
}

function setupError(request: NextRequest, error: string): NextResponse {
  const url = new URL("/setup", request.url);
  url.searchParams.set("error", error);
  return secure(NextResponse.redirect(url, 303));
}
