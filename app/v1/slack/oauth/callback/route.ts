import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getDelegatedDeliveryConfig, getSlackOAuthDeploymentConfig, isSetupRequiredError } from "../../../../../src/server/config";
import { createConfiguredCredentialCipher } from "../../../../../src/server/credentials/factory";
import { database } from "../../../../../src/server/db";
import { createPostgresDelegatedDeliveryStore } from "../../../../../src/server/delegated-delivery/postgres-store";
import { createDelegationOAuthResume, denyDelegationAfterOAuth } from "../../../../../src/server/delegated-delivery/service";
import { createFetchSlackOAuthClient } from "../../../../../src/server/slack/oauth-client";
import { createConfiguredSlackAppConfigurationResolver } from "../../../../../src/server/slack/app-configuration-factory";
import { completeSlackOAuthCallback, slackOAuthStateCookieName } from "../../../../../src/server/slack/oauth-flow";
import { createMockSlackOAuthClient } from "../../../../../src/server/slack/mock-oauth-client";
import { createPostgresOAuthFlowStore } from "../../../../../src/server/slack/postgres-store";
import { fetchAllGrantedSlackTeams } from "../../../../../src/server/slack/organization-workspaces";
import { createDefaultSlackWebApiClient } from "../../../../../src/server/slack/web-api-client";
import { setupSessionCookieName } from "../../../prism/setup/session/handler";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  let redirectUrl = fallbackRedirect("error");

  try {
    const deployment = getSlackOAuthDeploymentConfig();
    redirectUrl = `${deployment.publicBaseUrl.replace(/\/$/, "")}/?slack=error`;
    const callback = parseAuthorizationResponse(request.nextUrl.searchParams);
    if (!callback) {
      return secureOAuthResponse(NextResponse.redirect(redirectUrl, { status: 302 }), correlationId);
    }
    const cipher = createConfiguredCredentialCipher();
    const resolver = createConfiguredSlackAppConfigurationResolver({ database });
    const result = await completeSlackOAuthCallback({
      store: createPostgresOAuthFlowStore(database, { credentialCipher: cipher }),
      cipher,
      deployment,
      code: callback.code,
      state: callback.state,
      oauthError: callback.error,
      cookieState: request.cookies.get(slackOAuthStateCookieName)?.value ?? null,
      requestId: correlationId,
      discoverOrganizationWorkspaces: (accessToken) => fetchAllGrantedSlackTeams(createDefaultSlackWebApiClient(), accessToken),
      async resolveRuntime(binding) {
        const resolved = await resolver.resolveBinding({ binding });
        const config = resolved.oauthConfig;
        return {
          config,
          slackOAuthClient: config.mockOAuth
            ? createMockSlackOAuthClient({ botScopes: config.botScopes, userScopes: config.userScopes })
            : createFetchSlackOAuthClient({ clientId: config.clientId, clientSecret: config.clientSecret })
        };
      }
    });
    let continuationUrl = oidcResumeUrl(
        deployment.publicBaseUrl,
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
    if (!continuationUrl && result.remoteCodexPairingId) {
      continuationUrl = remoteCodexPairingResumeUrl(deployment.publicBaseUrl, result.remoteCodexPairingId);
    }
    const response = NextResponse.redirect(continuationUrl ?? result.redirectUrl, { status: 302 });
    if (result.kind !== "invalid_state") response.cookies.delete(slackOAuthStateCookieName);
    if (result.sessionCookie) {
      response.cookies.set(result.sessionCookie.name, result.sessionCookie.value, {
        httpOnly: result.sessionCookie.httpOnly,
        sameSite: result.sessionCookie.sameSite,
        secure: result.sessionCookie.secure,
        path: result.sessionCookie.path,
        maxAge: result.sessionCookie.maxAge
      });
    }
    if (result.kind === "linked" && result.setupConfigurationActivated) {
      response.cookies.delete(setupSessionCookieName);
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

function remoteCodexPairingResumeUrl(publicBaseUrl: string, pairingId: string): string | null {
  if (!/^rc_pair_[A-Za-z0-9_-]{8,120}$/.test(pairingId)) return null;
  return new URL(`/remote-codex/pair/${encodeURIComponent(pairingId)}`, publicBaseUrl).toString();
}

type ParsedAuthorizationResponse = {
  state: string;
  code: string | null;
  error: string | null;
};

function parseAuthorizationResponse(params: URLSearchParams): ParsedAuthorizationResponse | null {
  if ([...params.keys()].some((key) => key !== "state" && key !== "code" && key !== "error")) {
    return null;
  }
  const states = params.getAll("state");
  const codes = params.getAll("code");
  const errors = params.getAll("error");
  if (
    states.length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(states[0]!) ||
    codes.length > 1 ||
    errors.length > 1 ||
    (codes.length === 1) === (errors.length === 1)
  ) {
    return null;
  }
  const code = codes[0] ?? null;
  const error = errors[0] ?? null;
  if (
    (code !== null && (!code || code.length > 2048 || /[\u0000-\u001f\u007f]/.test(code))) ||
    (error !== null && (!/^[A-Za-z0-9._-]{1,120}$/.test(error)))
  ) {
    return null;
  }
  return { state: states[0]!, code, error };
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
