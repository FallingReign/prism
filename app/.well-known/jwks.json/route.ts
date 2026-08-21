import { NextResponse } from "next/server";

import { getOidcProviderConfig } from "../../../src/server/config";
import { createOidcSigningService } from "../../../src/server/oidc/signing";

export const dynamic = "force-dynamic";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer"
};

export async function GET(): Promise<NextResponse> {
  try {
    const service = await createOidcSigningService(getOidcProviderConfig());
    return NextResponse.json(
      { keys: [service.publicJwk] },
      {
        status: 200,
        headers: NO_CACHE_HEADERS
      }
    );
  } catch {
    return NextResponse.json(
      { error: "server_configuration_error" },
      {
        status: 500,
        headers: NO_CACHE_HEADERS
      }
    );
  }
}
