import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

const { oidcStore } = vi.hoisted(() => ({ oidcStore: { resolveAccessToken: vi.fn() } }));
vi.mock("../../../src/server/db", () => ({ database: {} }));
vi.mock("../../../src/server/oidc/postgres-store", () => ({ createPostgresOidcStore: () => oidcStore }));
vi.mock("../../../src/server/config", () => ({
  getOidcProviderConfig: () => ({
    issuer: "https://prism.example",
    playtestClient: { clientId: "shg-playtest", redirectUri: "https://playtest.example/api/auth/callback", tokenEndpointAuthMethod: "none" },
    signing: { privateKeyBase64: "unused", keyId: "kid" }, allowInsecureHttp: false
  })
}));

describe("GET /oauth/userinfo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns cryptographically bound Prism and Slack identity claims", async () => {
    oidcStore.resolveAccessToken.mockResolvedValueOnce({
      prismUserId: "user-1", slackConnectionId: "connection-1", clientId: "shg-playtest", scope: "openid profile",
      slackUserId: "U1", slackUserDisplayName: "Ada", teamId: "T1", teamName: "Studio",
      enterpriseId: null, enterpriseName: null
    });
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("https://prism.example/oauth/userinfo", {
      headers: { authorization: `Bearer ${"a".repeat(43)}` }
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      sub: "user-1", name: "Ada", preferred_username: "Ada", slack_user_id: "U1", slack_team_id: "T1"
    });
  });

  it("rejects missing or malformed bearer credentials generically", async () => {
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("https://prism.example/oauth/userinfo"));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    await expect(response.json()).resolves.toEqual({ error: "invalid_token" });
    expect(oidcStore.resolveAccessToken).not.toHaveBeenCalled();
  });
});
