import { NextResponse } from "next/server";

import { getOidcProviderConfig } from "../../../src/server/config";

export const dynamic = "force-dynamic";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer"
};

export function GET(): NextResponse {
  try {
    const { issuer } = getOidcProviderConfig();
    return json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      userinfo_endpoint: `${issuer}/oauth/userinfo`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "profile", "email"],
      claims_supported: [
        "sub",
        "name",
        "preferred_username",
        "slack_user_id",
        "slack_team_id",
        "slack_enterprise_id",
        "auth_time",
        "nonce"
      ]
    });
  } catch {
    return json({ error: "server_configuration_error" }, 500);
  }
}

function json(body: object, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: NO_CACHE_HEADERS
  });
}
