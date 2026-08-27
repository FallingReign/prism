import { NextRequest, NextResponse } from "next/server";

import { getOidcProviderConfig } from "../../../src/server/config";
import { database } from "../../../src/server/db";
import { createPostgresOidcStore } from "../../../src/server/oidc/postgres-store";
import { resolveOidcAuthorizationSource } from "../../../src/server/oidc/request-source";
import { authorizeOidcRequest } from "../../../src/server/oidc/service";
import { getSlackLinkStatusWithDisplayNameEnrichment } from "../../../src/server/slack/connection-status";
import { prismSessionCookieName } from "../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const config = getOidcProviderConfig();
    const sessionToken = request.cookies.get(prismSessionCookieName)?.value;
    const decision = await authorizeOidcRequest({
      url: new URL(request.url),
      sessionToken,
      store: createPostgresOidcStore(database),
      config,
      enrichSessionDisplayName: async () => {
        await getSlackLinkStatusWithDisplayNameEnrichment({ database, sessionToken });
      },
      sourceIdentifier: resolveOidcAuthorizationSource(
        request.headers,
        config.abuseProtection.trustProxyHeaders
      )
    });
    const response = secureOidcResponse(
      decision.kind === "redirect"
        ? NextResponse.redirect(decision.location, { status: 302 })
        : NextResponse.json({ error: decision.error }, { status: decision.status })
    );
    if (decision.kind === "error" && decision.status === 429 && decision.retryAfterSeconds) {
      response.headers.set("Retry-After", String(decision.retryAfterSeconds));
    }
    return response;
  } catch {
    return secureOidcResponse(NextResponse.json({ error: "server_error" }, { status: 500 }));
  }
}

function secureOidcResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
