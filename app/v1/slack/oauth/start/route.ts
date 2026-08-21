import { NextRequest, NextResponse } from "next/server";

import { getSlackOAuthConfig, isSetupRequiredError } from "../../../../../src/server/config";
import { database } from "../../../../../src/server/db";
import { createSlackOAuthStart } from "../../../../../src/server/slack/oauth-flow";
import { createPostgresOAuthFlowStore } from "../../../../../src/server/slack/postgres-store";

export const dynamic = "force-dynamic";

export async function GET(request?: NextRequest): Promise<NextResponse> {
  try {
    const config = getSlackOAuthConfig();
    const oidcAuthorizationRequestId = request
      ? validOidcRequestId(request.nextUrl.searchParams.get("oidc_request"))
      : null;
    if (request?.nextUrl.searchParams.has("oidc_request") && !oidcAuthorizationRequestId) {
      return secureOAuthResponse(
        NextResponse.redirect(errorRedirect(), { status: 302 })
      );
    }
    const start = await createSlackOAuthStart({
      store: createPostgresOAuthFlowStore(database),
      config,
      oidcAuthorizationRequestId
    });
    const response = NextResponse.redirect(start.redirectUrl, { status: 302 });
    response.cookies.set(start.cookie.name, start.cookie.value, {
      httpOnly: start.cookie.httpOnly,
      sameSite: start.cookie.sameSite,
      secure: start.cookie.secure,
      path: start.cookie.path,
      maxAge: start.cookie.maxAge
    });
    return secureOAuthResponse(response);
  } catch (error) {
    if (isSetupRequiredError(error)) {
      return secureOAuthResponse(
        NextResponse.redirect(setupRedirect(), { status: 302 })
      );
    }
    return secureOAuthResponse(
      NextResponse.redirect(errorRedirect(), { status: 302 })
    );
  }
}

function validOidcRequestId(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function secureOAuthResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
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
