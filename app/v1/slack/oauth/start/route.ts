import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getDelegatedDeliveryConfig, isSetupRequiredError } from "../../../../../src/server/config";
import { database } from "../../../../../src/server/db";
import { createConfiguredSlackAppConfigurationResolver } from "../../../../../src/server/slack/app-configuration-factory";
import { createSlackOAuthStart } from "../../../../../src/server/slack/oauth-flow";
import { createPostgresOAuthFlowStore } from "../../../../../src/server/slack/postgres-store";

export const dynamic = "force-dynamic";

export async function GET(request?: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  try {
    const continuation = parseContinuation(request?.nextUrl.searchParams);
    if (continuation.kind === "invalid") {
      return secureOAuthResponse(
        NextResponse.redirect(errorRedirect(), { status: 302 }), correlationId
      );
    }
    if (continuation.delegatedDeliveryRequestId && !getDelegatedDeliveryConfig().enabled) {
      return secureOAuthResponse(NextResponse.redirect(errorRedirect(), { status: 302 }), correlationId);
    }
    const resolved = await createConfiguredSlackAppConfigurationResolver({ database }).resolveOrdinary();
    const config = resolved.oauthConfig;
    const start = await createSlackOAuthStart({
      store: createPostgresOAuthFlowStore(database),
      config,
      configurationBinding: resolved.binding,
      oidcAuthorizationRequestId: continuation.oidcAuthorizationRequestId,
      delegatedDeliveryRequestId: continuation.delegatedDeliveryRequestId
    });
    const response = NextResponse.redirect(start.redirectUrl, { status: 302 });
    response.cookies.set(start.cookie.name, start.cookie.value, {
      httpOnly: start.cookie.httpOnly,
      sameSite: start.cookie.sameSite,
      secure: start.cookie.secure,
      path: start.cookie.path,
      maxAge: start.cookie.maxAge
    });
    return secureOAuthResponse(response, correlationId);
  } catch (error) {
    if (isSetupRequiredError(error)) {
      return secureOAuthResponse(
        NextResponse.redirect(setupRedirect(), { status: 302 }), correlationId
      );
    }
    return secureOAuthResponse(
      NextResponse.redirect(errorRedirect(), { status: 302 }), correlationId
    );
  }
}

function parseContinuation(params?: URLSearchParams):
  | { kind: "valid"; oidcAuthorizationRequestId: string | null; delegatedDeliveryRequestId: string | null }
  | { kind: "invalid" } {
  if (!params) return { kind: "valid", oidcAuthorizationRequestId: null, delegatedDeliveryRequestId: null };
  if ([...params.keys()].some((key) => key !== "oidc_request" && key !== "delegation_request")) return { kind: "invalid" };
  const oidc = params.getAll("oidc_request");
  const delegated = params.getAll("delegation_request");
  if (oidc.length > 1 || delegated.length > 1 || (oidc.length === 1 && delegated.length === 1)) return { kind: "invalid" };
  if (oidc.length === 1 && !/^[A-Za-z0-9_-]{43}$/.test(oidc[0]!)) return { kind: "invalid" };
  if (delegated.length === 1 && !/^ddr_[A-Za-z0-9-]{16,64}$/.test(delegated[0]!)) return { kind: "invalid" };
  return {
    kind: "valid",
    oidcAuthorizationRequestId: oidc[0] ?? null,
    delegatedDeliveryRequestId: delegated[0] ?? null
  };
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

function setupRedirect(): string {
  const base = process.env.PRISM_PUBLIC_BASE_URL?.includes("replace-with")
    ? "http://localhost:3732"
    : process.env.PRISM_PUBLIC_BASE_URL || "http://localhost:3732";
  return `${base.replace(/\/$/, "")}/?slack=setup_required`;
}

function errorRedirect(): string {
  const base = process.env.PRISM_PUBLIC_BASE_URL?.includes("replace-with")
    ? "http://localhost:3732"
    : process.env.PRISM_PUBLIC_BASE_URL || "http://localhost:3732";
  return `${base.replace(/\/$/, "")}/?slack=error`;
}
