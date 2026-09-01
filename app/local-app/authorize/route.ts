import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { database } from "../../../src/server/db";
import { getSlackOAuthDeploymentConfig } from "../../../src/server/config";
import { rejectCrossOriginBrowserMutation } from "../../../src/server/http/browser-mutation-csrf";
import { localAppHtmlResponse, localAppRedirect, readBoundedUtf8Body, secureLocalAppResponse } from "../../../src/server/local-app-authorization/http";
import { createPostgresLocalAppAuthorizationStore } from "../../../src/server/local-app-authorization/postgres-store";
import { resolveLocalAppRequestSource } from "../../../src/server/local-app-authorization/request-source";
import { renderLocalAppConsentPage, renderLocalAppResultPage } from "../../../src/server/local-app-authorization/presentation";
import { decideLocalAppAuthorization, localAppUserCodeCookieName, resolveLocalAppConsent } from "../../../src/server/local-app-authorization/service";
import { canonicalUserCode } from "../../../src/server/local-app-authorization/validation";
import { prismSessionCookieName } from "../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  let publicBaseUrl: string;
  try {
    publicBaseUrl = getSlackOAuthDeploymentConfig().publicBaseUrl;
  } catch {
    return localAppHtmlResponse(renderLocalAppResultPage("unavailable"), 503, requestId);
  }
  if (request.headers.has("authorization")) {
    return localAppHtmlResponse(renderLocalAppResultPage("unavailable"), 400, requestId);
  }
  const query = parseConsentQuery(request.nextUrl.searchParams);
  if (!query) return localAppHtmlResponse(renderLocalAppResultPage("unavailable"), 400, requestId);
  if (request.nextUrl.searchParams.get("error") === "access_denied") {
    const response = localAppHtmlResponse(renderLocalAppResultPage("denied"), 400, requestId);
    return "requestId" in query ? clearUserCodeCookie(response, query.requestId) : response;
  }
  const rawUserCode = "userCode" in query
    ? query.userCode
    : request.cookies.get(localAppUserCodeCookieName(query.requestId))?.value;
  const userCode = rawUserCode ? canonicalUserCode(rawUserCode) : null;
  let result: Awaited<ReturnType<typeof resolveLocalAppConsent>>;
  try {
    result = await resolveLocalAppConsent({
      store: createPostgresLocalAppAuthorizationStore(database),
      ...query,
      ...(userCode ? { userCode } : {}),
      sessionToken: request.cookies.get(prismSessionCookieName)?.value,
      sourceIdentifier: resolveLocalAppRequestSource(request.headers)
    });
  } catch {
    return localAppHtmlResponse(renderLocalAppResultPage("unavailable"), 503, requestId);
  }
  if (result.kind === "login_required") {
    const oauth = new URL("/v1/slack/oauth/start", publicBaseUrl);
    oauth.searchParams.set("local_app_request", result.requestId);
    const response = localAppRedirect(oauth.toString(), 302, requestId);
    if (userCode) setUserCodeCookie(response, result.requestId, userCode, publicBaseUrl);
    return response;
  }
  if (result.kind === "preview") {
    return clearUserCodeCookie(localAppHtmlResponse(renderLocalAppConsentPage(result.preview), 200, requestId), result.preview.requestId);
  }
  if (result.kind === "connection_unavailable") {
    const oauth = new URL("/v1/slack/oauth/start", publicBaseUrl);
    oauth.searchParams.set("local_app_request", result.requestId);
    const response = localAppHtmlResponse(renderLocalAppResultPage("connection_unavailable", {
      reconnectUrl: oauth.toString()
    }), 409, requestId);
    if (userCode) setUserCodeCookie(response, result.requestId, userCode, publicBaseUrl);
    return response;
  }
  const status = result.kind === "rate_limited" ? 429 : 400;
  const response = localAppHtmlResponse(renderLocalAppResultPage("unavailable"), status, requestId);
  return "requestId" in query ? clearUserCodeCookie(response, query.requestId) : response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const csrf = rejectCrossOriginBrowserMutation(request);
  if (csrf) return secureLocalAppResponse(csrf, requestId);
  if (request.nextUrl.search || request.headers.has("authorization") || request.headers.get("content-type") !== "application/x-www-form-urlencoded") {
    return localAppHtmlResponse(renderLocalAppResultPage("unavailable"), 400, requestId);
  }
  const body = await readBoundedUtf8Body(request, 1_024);
  if (body === null) return localAppHtmlResponse(renderLocalAppResultPage("unavailable"), 400, requestId);
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => key !== "request" && key !== "decision") || form.getAll("request").length !== 1 || form.getAll("decision").length !== 1) {
    return localAppHtmlResponse(renderLocalAppResultPage("unavailable"), 400, requestId);
  }
  const decision = form.get("decision");
  if (decision !== "approve" && decision !== "deny") {
    return localAppHtmlResponse(renderLocalAppResultPage("unavailable"), 400, requestId);
  }
  let result: Awaited<ReturnType<typeof decideLocalAppAuthorization>>;
  try {
    result = await decideLocalAppAuthorization({
      store: createPostgresLocalAppAuthorizationStore(database),
      requestId: form.get("request") ?? "",
      sessionToken: request.cookies.get(prismSessionCookieName)?.value,
      decision,
      auditRequestId: requestId
    });
  } catch {
    return localAppHtmlResponse(renderLocalAppResultPage("unavailable"), 503, requestId);
  }
  const status = result === "approved" || result === "denied" ? 200 : result === "connection_unavailable" ? 409 : 400;
  return clearUserCodeCookie(localAppHtmlResponse(renderLocalAppResultPage(result), status, requestId), form.get("request") ?? "");
}

function setUserCodeCookie(response: NextResponse, authorizationRequestId: string, userCode: string, publicBaseUrl: string): void {
  response.cookies.set(localAppUserCodeCookieName(authorizationRequestId), userCode, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(publicBaseUrl).protocol === "https:",
    path: "/local-app",
    maxAge: 10 * 60
  });
}

function clearUserCodeCookie(response: NextResponse, authorizationRequestId: string): NextResponse {
  response.cookies.delete({
    name: localAppUserCodeCookieName(authorizationRequestId),
    path: "/local-app"
  });
  return response;
}

function parseConsentQuery(params: URLSearchParams): { userCode: string } | { requestId: string } | null {
  if ([...params.keys()].some((key) => key !== "user_code" && key !== "request" && key !== "error")) return null;
  const errors = params.getAll("error");
  if (errors.length > 1 || (errors.length === 1 && errors[0] !== "access_denied")) return null;
  const userCode = params.getAll("user_code");
  const request = params.getAll("request");
  if (userCode.length + request.length !== 1) return null;
  if (userCode.length === 1) return { userCode: userCode[0]! };
  return { requestId: request[0]! };
}
