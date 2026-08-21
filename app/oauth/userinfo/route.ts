import { NextRequest, NextResponse } from "next/server";

import { getOidcProviderConfig } from "../../../src/server/config";
import { database } from "../../../src/server/db";
import { createPostgresOidcStore } from "../../../src/server/oidc/postgres-store";
import { resolveOidcUserInfo } from "../../../src/server/oidc/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const decision = await resolveOidcUserInfo({
      authorization: request.headers.get("authorization"),
      store: createPostgresOidcStore(database),
      config: getOidcProviderConfig()
    });
    const response = secureOidcJson(
      decision.kind === "success" ? decision.body : { error: decision.error },
      decision.kind === "success" ? 200 : decision.status
    );
    if (decision.kind === "error" && decision.status === 401) {
      response.headers.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    }
    return response;
  } catch {
    return secureOidcJson({ error: "server_error" }, 500);
  }
}

function secureOidcJson(body: object, status: number): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
