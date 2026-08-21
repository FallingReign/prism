import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

function configure() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.NODE_ENV = "test";
  process.env.PRISM_PUBLIC_BASE_URL = "http://localhost:3732";
  process.env.PRISM_OIDC_ALLOW_INSECURE_HTTP = "1";
  process.env.PRISM_OIDC_PLAYTEST_CLIENT_ID = "shg-playtest";
  process.env.PRISM_OIDC_PLAYTEST_REDIRECT_URI = "http://localhost:3847/api/auth/callback";
  process.env.PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64 = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
  process.env.PRISM_OIDC_SIGNING_KEY_ID = "test-rs256-v1";
}

describe("GET /.well-known/openid-configuration", () => {
  beforeEach(() => {
    configure();
  });

  it("returns exact first-party authorization-code metadata", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(body).toEqual({
      issuer: "http://localhost:3732",
      authorization_endpoint: "http://localhost:3732/oauth/authorize",
      token_endpoint: "http://localhost:3732/oauth/token",
      userinfo_endpoint: "http://localhost:3732/oauth/userinfo",
      jwks_uri: "http://localhost:3732/.well-known/jwks.json",
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "profile", "email"],
      claims_supported: ["sub", "name", "preferred_username", "slack_user_id", "slack_team_id", "slack_enterprise_id", "auth_time", "nonce"]
    });
  });
});
