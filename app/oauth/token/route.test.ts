import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

const { oidcStore, signing } = vi.hoisted(() => ({
  oidcStore: {
    exchangeAuthorizationCode: vi.fn(),
    resolveAccessToken: vi.fn()
  },
  signing: { keyId: "kid", publicJwk: {}, sign: vi.fn(async () => "signed-id-token") }
}));

vi.mock("../../../src/server/db", () => ({ database: {} }));
vi.mock("../../../src/server/oidc/postgres-store", () => ({ createPostgresOidcStore: () => oidcStore }));
vi.mock("../../../src/server/oidc/signing", () => ({ createOidcSigningService: async () => signing }));
vi.mock("../../../src/server/config", () => ({
  getOidcProviderConfig: () => ({
    issuer: "https://prism.example",
    playtestClient: { clientId: "shg-playtest", redirectUri: "https://playtest.example/api/auth/callback", tokenEndpointAuthMethod: "none" },
    signing: { privateKeyBase64: "unused", keyId: "kid" }, allowInsecureHttp: false
  })
}));

const form = new URLSearchParams({
  grant_type: "authorization_code", client_id: "shg-playtest",
  redirect_uri: "https://playtest.example/api/auth/callback",
  code: "authorization-code", code_verifier: "v".repeat(43)
});

describe("POST /oauth/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oidcStore.exchangeAuthorizationCode.mockResolvedValue({
      token: "a".repeat(43),
      authorizationCode: {
        prismUserId: "user-1", slackConnectionId: "connection-1", clientId: "shg-playtest",
        redirectUri: "https://playtest.example/api/auth/callback", nonce: "nonce-1", scope: "openid profile",
        codeChallenge: "c".repeat(43), codeChallengeMethod: "S256", authTime: new Date("2026-08-21T00:00:00.000Z")
      }
    });
    oidcStore.resolveAccessToken.mockResolvedValue({
      prismUserId: "user-1", slackConnectionId: "connection-1", clientId: "shg-playtest", scope: "openid profile",
      slackUserId: "U1", slackUserDisplayName: "Ada", teamId: "T1", teamName: "Studio",
      enterpriseId: null, enterpriseName: null
    });
  });

  it("accepts only a form-encoded one-time code exchange", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://prism.example/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: form.toString()
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(body).toMatchObject({ access_token: "a".repeat(43), token_type: "Bearer", expires_in: 300, id_token: "signed-id-token" });
    expect(oidcStore.exchangeAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({
      code: "authorization-code", clientId: "shg-playtest", codeVerifier: "v".repeat(43)
    }));
  });

  it("rejects JSON and does not attempt an exchange", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://prism.example/oauth/token", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    }));

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(oidcStore.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("rejects client authentication because Playtest is registered as a public client", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://prism.example/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic dW5zdXBwb3J0ZWQ="
      },
      body: form.toString()
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(oidcStore.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("rejects client credentials because Playtest is a public PKCE client", async () => {
    const { POST } = await import("./route");
    const withSecret = new URLSearchParams(form);
    withSecret.set("client_secret", "secret-canary");

    for (const request of [
      new NextRequest("https://prism.example/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: withSecret.toString()
      }),
      new NextRequest("https://prism.example/oauth/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Basic Y2xpZW50OnNlY3JldA=="
        },
        body: form.toString()
      })
    ]) {
      const response = await POST(request);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    }
    expect(oidcStore.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });
});
