import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import type { OidcAuthorizationPermit, OidcSessionIdentity } from "../../../src/server/oidc/postgres-store";

const { oidcStore, enrichSlackConnectionDisplayNames } = vi.hoisted(() => ({
  oidcStore: {
    consumeAuthorizationRequestPermit: vi.fn<() => Promise<OidcAuthorizationPermit>>(async () => ({ kind: "allowed" })),
    createPendingAuthorizationRequest: vi.fn(async () => ({ kind: "created" as const, requestId: "r".repeat(43) })),
    loadPendingAuthorizationRequest: vi.fn(async () => null),
    consumePendingAuthorizationRequest: vi.fn(async () => null),
    resolveEligiblePrismSessionIdentity: vi.fn<() => Promise<OidcSessionIdentity | null>>(async () => null),
    issueAuthorizationCode: vi.fn(async () => ({ code: "authorization-code" })),
    consumeAuthorizationCode: vi.fn(async () => null),
    exchangeAuthorizationCode: vi.fn(async () => null),
    issueAccessToken: vi.fn(async () => ({ token: "a".repeat(43) })),
    resolveAccessToken: vi.fn(async () => null),
    resolvePlaytestInitialAdminEligibility: vi.fn(async () => false)
  },
  enrichSlackConnectionDisplayNames: vi.fn(async () => ({ kind: "linked" as const }))
}));

vi.mock("../../../src/server/db", () => ({ database: {} }));
vi.mock("../../../src/server/oidc/postgres-store", () => ({ createPostgresOidcStore: () => oidcStore }));
vi.mock("../../../src/server/slack/connection-status", () => ({
  getSlackLinkStatusWithDisplayNameEnrichment: enrichSlackConnectionDisplayNames
}));
vi.mock("../../../src/server/config", () => ({
  getOidcProviderConfig: () => ({
    issuer: "https://prism.example",
    playtestClient: { clientId: "shg-playtest", redirectUri: "https://playtest.example/api/auth/callback", tokenEndpointAuthMethod: "none" },
    signing: { privateKeyBase64: "unused", keyId: "kid" }, allowInsecureHttp: false,
    abuseProtection: {
      authorizeWindowMs: 60_000, maxAuthorizeRequestsPerSource: 30,
      maxAuthorizeRequestsPerClient: 300, maxOutstandingPendingPerSource: 10,
      maxOutstandingPendingPerClient: 500, cleanupBatchSize: 100, trustProxyHeaders: false
    }
  })
}));

function authorizationUrl(redirectUri = "https://playtest.example/api/auth/callback"): string {
  const url = new URL("https://prism.example/oauth/authorize");
  for (const [name, value] of Object.entries({
    client_id: "shg-playtest", redirect_uri: redirectUri, response_type: "code", scope: "openid profile",
    state: "state-1", nonce: "nonce-1", code_challenge: "c".repeat(43), code_challenge_method: "S256"
  })) url.searchParams.set(name, value);
  return url.toString();
}

describe("GET /oauth/authorize", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the HttpOnly Prism session to complete first-party authorization", async () => {
    oidcStore.resolveEligiblePrismSessionIdentity.mockResolvedValueOnce({
      prismUserId: "user-1", slackConnectionId: "connection-1", slackUserId: "U1",
      slackUserDisplayName: "Ada", teamId: "T1", teamName: "Studio",
      enterpriseId: null, enterpriseName: null, authTime: new Date("2026-08-21T00:00:00.000Z")
    });
    const { GET } = await import("./route");
    const response = await GET(new NextRequest(authorizationUrl(), { headers: { cookie: "prism_session=session-token" } }));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://playtest.example/api/auth/callback?code=authorization-code&state=state-1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(oidcStore.resolveEligiblePrismSessionIdentity).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: "session-token" }));
  });

  it("refreshes a missing Slack display name during Playtest authorization without visiting Prism", async () => {
    const missingName = {
      prismUserId: "user-1", slackConnectionId: "connection-1", slackUserId: "U1",
      slackUserDisplayName: null, teamId: "T1", teamName: "Studio",
      enterpriseId: null, enterpriseName: null, authTime: new Date("2026-08-21T00:00:00.000Z")
    };
    oidcStore.resolveEligiblePrismSessionIdentity
      .mockResolvedValueOnce(missingName)
      .mockResolvedValueOnce({ ...missingName, slackUserDisplayName: "Ada" });
    const { GET } = await import("./route");

    const response = await GET(new NextRequest(authorizationUrl(), {
      headers: { cookie: "prism_session=session-token" }
    }));

    expect(response.status).toBe(302);
    expect(enrichSlackConnectionDisplayNames).toHaveBeenCalledWith({
      database: {}, sessionToken: "session-token"
    });
    expect(oidcStore.resolveEligiblePrismSessionIdentity).toHaveBeenCalledTimes(2);
  });

  it("does not redirect an unregistered callback", async () => {
    const { GET } = await import("./route");
    const response = await GET(new NextRequest(authorizationUrl("https://attacker.example/callback")));

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("returns Retry-After and does not persist when the shared limiter denies", async () => {
    oidcStore.consumeAuthorizationRequestPermit.mockResolvedValueOnce({
      kind: "limited" as const,
      retryAfterSeconds: 37
    });
    const { GET } = await import("./route");
    const response = await GET(new NextRequest(authorizationUrl(), {
      headers: { "x-forwarded-for": "203.0.113.10" }
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(oidcStore.consumeAuthorizationRequestPermit).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIdentifier: "unattributed" })
    );
    expect(oidcStore.createPendingAuthorizationRequest).not.toHaveBeenCalled();
  });
});
