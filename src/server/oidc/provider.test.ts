import { describe, expect, it } from "vitest";

import type { OidcProviderConfig } from "../config";
import {
  authorizationErrorRedirect,
  validateAuthorizationRequest,
  validateTokenRequest
} from "./provider";

const config: OidcProviderConfig = {
  issuer: "https://prism.example",
  playtestClient: {
    clientId: "shg-playtest",
    redirectUri: "https://playtest.example/api/auth/callback",
    tokenEndpointAuthMethod: "none"
  },
  signing: { privateKeyBase64: "unused", keyId: "test-key" },
  allowInsecureHttp: false,
  abuseProtection: {
    authorizeWindowMs: 60_000, maxAuthorizeRequestsPerSource: 30,
    maxAuthorizeRequestsPerClient: 300, maxOutstandingPendingPerSource: 10,
    maxOutstandingPendingPerClient: 500, cleanupBatchSize: 100, trustProxyHeaders: false
  }
};

function authorizationUrl(overrides: Record<string, string | string[]> = {}) {
  const values: Record<string, string | string[]> = {
    client_id: "shg-playtest",
    redirect_uri: "https://playtest.example/api/auth/callback",
    response_type: "code",
    scope: "openid profile email",
    state: "state-123",
    nonce: "nonce-123",
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    ...overrides
  };
  const url = new URL("https://prism.example/oauth/authorize");
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, item);
    }
  }
  return url;
}

describe("OIDC provider request validation", () => {
  it("accepts only the registered code-flow request with S256 PKCE", () => {
    expect(validateAuthorizationRequest(authorizationUrl(), config)).toEqual({
      kind: "valid",
      request: {
        clientId: "shg-playtest",
        redirectUri: "https://playtest.example/api/auth/callback",
        responseType: "code",
        scope: "openid profile email",
        state: "state-123",
        nonce: "nonce-123",
        codeChallenge: "c".repeat(43),
        codeChallengeMethod: "S256"
      }
    });
  });

  it.each([
    ["unknown client", { client_id: "attacker" }],
    ["redirect prefix", { redirect_uri: "https://playtest.example/api/auth/callback/extra" }],
    ["alternate port", { redirect_uri: "https://playtest.example:444/api/auth/callback" }],
    ["implicit flow", { response_type: "token" }],
    ["missing openid", { scope: "profile email" }],
    ["unsupported scope", { scope: "openid admin" }],
    ["missing state", { state: "" }],
    ["missing nonce", { nonce: "" }],
    ["plain PKCE", { code_challenge_method: "plain" }],
    ["malformed challenge", { code_challenge: "not-a-sha256-challenge" }],
    ["unsupported prompt", { prompt: "none" }],
    ["unsupported resource", { resource: "https://resource.example" }],
    ["duplicate client", { client_id: ["shg-playtest", "attacker"] }],
    ["duplicate redirect", { redirect_uri: ["https://playtest.example/api/auth/callback", "https://attacker.example/callback"] }]
  ])("rejects %s", (_label, overrides) => {
    expect(validateAuthorizationRequest(authorizationUrl(overrides), config)).toMatchObject({ kind: "invalid" });
  });

  it("redirects errors only to a previously validated client redirect and preserves state", () => {
    const valid = validateAuthorizationRequest(authorizationUrl(), config);
    expect(valid.kind).toBe("valid");
    if (valid.kind !== "valid") throw new Error("expected valid request");

    const redirect = authorizationErrorRedirect(valid.request, "access_denied");
    expect(redirect.toString()).toBe(
      "https://playtest.example/api/auth/callback?error=access_denied&state=state-123"
    );
    expect(redirect.searchParams.has("error_description")).toBe(false);
  });

  it("validates a public-client authorization-code token request and strict verifier", () => {
    expect(validateTokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "shg-playtest",
      redirect_uri: "https://playtest.example/api/auth/callback",
      code: "authorization-code",
      code_verifier: "v".repeat(43)
    }), config)).toEqual({
      kind: "valid",
      request: {
        clientId: "shg-playtest",
        redirectUri: "https://playtest.example/api/auth/callback",
        code: "authorization-code",
        codeVerifier: "v".repeat(43)
      }
    });
  });

  it.each([
    { grant_type: "refresh_token" },
    { client_id: "attacker" },
    { redirect_uri: "https://playtest.example/api/auth/callback/extra" },
    { code: "" },
    { code_verifier: "short" }
  ])("rejects an invalid token request %#", (override) => {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "shg-playtest",
      redirect_uri: "https://playtest.example/api/auth/callback",
      code: "authorization-code",
      code_verifier: "v".repeat(43),
      ...override
    });
    expect(validateTokenRequest(params, config)).toMatchObject({ kind: "invalid" });
  });

  it("rejects duplicate token parameters", () => {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "shg-playtest",
      redirect_uri: "https://playtest.example/api/auth/callback",
      code: "authorization-code",
      code_verifier: "v".repeat(43)
    });
    params.append("code", "second-code");
    expect(validateTokenRequest(params, config)).toMatchObject({ kind: "invalid" });
  });

  it.each(["resource", "client_assertion", "foo"])("rejects unsupported token parameter %s", (name) => {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "shg-playtest",
      redirect_uri: "https://playtest.example/api/auth/callback",
      code: "authorization-code",
      code_verifier: "v".repeat(43)
    });
    params.set(name, "unsupported");
    expect(validateTokenRequest(params, config)).toMatchObject({ kind: "invalid", error: "invalid_request" });
  });
});
