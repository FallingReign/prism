import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getDelegatedDeliveryConfig, getSlackOAuthConfig, isSetupRequiredError } from "../../../../../src/server/config";
import { createConfiguredCredentialCipher } from "../../../../../src/server/credentials/factory";
import { database } from "../../../../../src/server/db";
import { createPostgresDelegatedDeliveryStore } from "../../../../../src/server/delegated-delivery/postgres-store";
import { createDelegationOAuthResume, denyDelegationAfterOAuth } from "../../../../../src/server/delegated-delivery/service";
import { createFetchSlackOAuthClient } from "../../../../../src/server/slack/oauth-client";
import { completeSlackOAuthCallback, slackOAuthStateCookieName } from "../../../../../src/server/slack/oauth-flow";
import { createMockSlackOAuthClient } from "../../../../../src/server/slack/mock-oauth-client";
import { createPostgresOAuthFlowStore } from "../../../../../src/server/slack/postgres-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  let redirectUrl = fallbackRedirect("error");

  try {
    const config = getSlackOAuthConfig();
    redirectUrl = `${config.publicBaseUrl.replace(/\/$/, "")}/?slack=error`;
    const url = new URL(request.url);
    const result = await completeSlackOAuthCallback({
      store: createPostgresOAuthFlowStore(database),
      cipher: createConfiguredCredentialCipher(),
      config,
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      oauthError: url.searchParams.get("error"),
      cookieState: request.cookies.get(slackOAuthStateCookieName)?.value ?? null,
      slackOAuthClient: config.mockOAuth
        ? createMockSlackOAuthClient({ botScopes: config.botScopes, userScopes: config.userScopes })
        : createFetchSlackOAuthClient({ clientId: config.clientId, clientSecret: config.clientSecret })
    });
    let continuationUrl = oidcResumeUrl(
        config.publicBaseUrl,
        result.oidcAuthorizationRequestId,
        result.kind === "linked" ? null : "access_denied"
      );
    if (!continuationUrl && result.delegatedDeliveryRequestId) {
      const delegatedConfig = getDelegatedDeliveryConfig();
      if (delegatedConfig.enabled) {
        const decision = result.kind === "linked"
          ? await createDelegationOAuthResume({
              requestId: result.delegatedDeliveryRequestId,
              store: createPostgresDelegatedDeliveryStore(database),
              config: delegatedConfig
            })
          : await denyDelegationAfterOAuth({
              requestId: result.delegatedDeliveryRequestId,
              store: createPostgresDelegatedDeliveryStore(database),
              cipher: createConfiguredCredentialCipher(),
              config: delegatedConfig
            });
        if (decision.kind === "redirect") continuationUrl = decision.location;
      }
    }
    const response = NextResponse.redirect(continuationUrl ?? result.redirectUrl, { status: 302 });
    response.cookies.delete(slackOAuthStateCookieName);
    if (result.sessionCookie) {
      response.cookies.set(result.sessionCookie.name, result.sessionCookie.value, {
        httpOnly: result.sessionCookie.httpOnly,
        sameSite: result.sessionCookie.sameSite,
        secure: result.sessionCookie.secure,
        path: result.sessionCookie.path,
        maxAge: result.sessionCookie.maxAge
      });
    }
    return secureOAuthResponse(response, correlationId);
  } catch (error) {
    if (isSetupRequiredError(error)) {
      redirectUrl = fallbackRedirect("setup_required");
    }
    const response = NextResponse.redirect(redirectUrl, { status: 302 });
    response.cookies.delete(slackOAuthStateCookieName);
    return secureOAuthResponse(response, correlationId);
  }
}

function oidcResumeUrl(
  publicBaseUrl: string,
  requestId: string | null | undefined,
  error: "access_denied" | null
): string | null {
  if (!requestId || !/^[A-Za-z0-9_-]{43}$/.test(requestId)) return null;
  const url = new URL("/oauth/authorize", publicBaseUrl);
  url.searchParams.set("request", requestId);
  if (error) url.searchParams.set("error", error);
  return url.toString();
}

function secureOAuthResponse(response: NextResponse, requestId: string): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Prism-Request-ID", requestId);
  return response;
}

function fallbackRedirect(status: "error" | "setup_required"): string {
  const base = process.env.PRISM_PUBLIC_BASE_URL?.includes("replace-with")
    ? "http://localhost:3732"
    : process.env.PRISM_PUBLIC_BASE_URL || "http://localhost:3732";
  return `${base.replace(/\/$/, "")}/?slack=${status}`;
}
