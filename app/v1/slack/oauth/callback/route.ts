import { NextRequest, NextResponse } from "next/server";

import { getSlackOAuthConfig, isSetupRequiredError } from "../../../../../src/server/config";
import { createConfiguredCredentialCipher } from "../../../../../src/server/credentials/factory";
import { database } from "../../../../../src/server/db";
import { createFetchSlackOAuthClient } from "../../../../../src/server/slack/oauth-client";
import { completeSlackOAuthCallback, slackOAuthStateCookieName } from "../../../../../src/server/slack/oauth-flow";
import { createMockSlackOAuthClient } from "../../../../../src/server/slack/mock-oauth-client";
import { createPostgresOAuthFlowStore } from "../../../../../src/server/slack/postgres-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
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
      cookieState: request.cookies.get(slackOAuthStateCookieName)?.value ?? null,
      slackOAuthClient: config.mockOAuth
        ? createMockSlackOAuthClient()
        : createFetchSlackOAuthClient({ clientId: config.clientId, clientSecret: config.clientSecret })
    });
    const response = NextResponse.redirect(result.redirectUrl, { status: 302 });
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
    return response;
  } catch (error) {
    if (isSetupRequiredError(error)) {
      redirectUrl = fallbackRedirect("setup_required");
    }
    return NextResponse.redirect(redirectUrl, { status: 302 });
  }
}

function fallbackRedirect(status: "error" | "setup_required"): string {
  const base = process.env.PRISM_PUBLIC_BASE_URL?.includes("replace-with")
    ? "http://localhost:3732"
    : process.env.PRISM_PUBLIC_BASE_URL || "http://localhost:3732";
  return `${base.replace(/\/$/, "")}/?slack=${status}`;
}
