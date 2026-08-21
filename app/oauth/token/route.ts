import { NextRequest, NextResponse } from "next/server";

import { getOidcProviderConfig } from "../../../src/server/config";
import { database } from "../../../src/server/db";
import { createPostgresOidcStore } from "../../../src/server/oidc/postgres-store";
import { exchangeOidcCode } from "../../../src/server/oidc/service";
import { createOidcSigningService } from "../../../src/server/oidc/signing";

export const dynamic = "force-dynamic";
const MAX_FORM_BYTES = 16 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // This is an explicitly registered public PKCE client. Silently accepting a
  // Basic credential or body secret would create a misleading second client
  // authentication mode and make configuration mistakes harder to detect.
  if (request.headers.has("authorization")) {
    return secureOidcJson({ error: "invalid_request" }, 400);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return secureOidcJson({ error: "invalid_request" }, 415);
  }
  if (request.headers.has("authorization")) {
    return secureOidcJson({ error: "invalid_request" }, 400);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_FORM_BYTES) {
    return secureOidcJson({ error: "invalid_request" }, 400);
  }

  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_FORM_BYTES) {
      return secureOidcJson({ error: "invalid_request" }, 400);
    }
    const params = new URLSearchParams(body);
    if (params.has("client_secret")) {
      return secureOidcJson({ error: "invalid_request" }, 400);
    }
    const config = getOidcProviderConfig();
    const decision = await exchangeOidcCode({
      params,
      store: createPostgresOidcStore(database),
      signing: await createOidcSigningService(config),
      config
    });
    return decision.kind === "success"
      ? secureOidcJson(decision.body, 200)
      : secureOidcJson({ error: decision.error }, decision.status);
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
