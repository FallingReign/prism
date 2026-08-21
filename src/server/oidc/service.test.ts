import { describe, expect, it, vi } from "vitest";

import type { OidcProviderConfig } from "../config";
import type { OidcStore } from "./postgres-store";
import type { OidcSigningService } from "./signing";
import {
  authorizeOidcRequest,
  exchangeOidcCode,
  resolveOidcUserInfo
} from "./service";

const now = new Date("2026-08-21T00:00:00.000Z");
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
    authorizeWindowMs: 60_000,
    maxAuthorizeRequestsPerSource: 30,
    maxAuthorizeRequestsPerClient: 300,
    maxOutstandingPendingPerSource: 10,
    maxOutstandingPendingPerClient: 500,
    cleanupBatchSize: 100,
    trustProxyHeaders: false
  }
};

function authorizationUrl(overrides: Record<string, string> = {}): URL {
  const url = new URL("https://prism.example/oauth/authorize");
  const values = {
    client_id: "shg-playtest",
    redirect_uri: config.playtestClient.redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state: "state-123",
    nonce: "nonce-123",
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    ...overrides
  };
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  return url;
}

const identity = {
  prismUserId: "prism-user-1",
  slackConnectionId: "connection-1",
  slackUserId: "U123",
  slackUserDisplayName: "Ada Lovelace",
  teamId: "T123",
  teamName: "Studio",
  enterpriseId: "E123",
  enterpriseName: "Company",
  authTime: new Date("2026-08-20T23:59:00.000Z")
};

function store(overrides: Partial<OidcStore> = {}): OidcStore {
  return {
    consumeAuthorizationRequestPermit: vi.fn(async () => ({ kind: "allowed" as const })),
    createPendingAuthorizationRequest: vi.fn(async () => ({ kind: "created" as const, requestId: "r".repeat(43) })),
    loadPendingAuthorizationRequest: vi.fn(async () => null),
    consumePendingAuthorizationRequest: vi.fn(async () => null),
    resolveEligiblePrismSessionIdentity: vi.fn(async () => null),
    issueAuthorizationCode: vi.fn(async () => ({ code: "authorization-code" })),
    consumeAuthorizationCode: vi.fn(async () => null),
    exchangeAuthorizationCode: vi.fn(async () => null),
    issueAccessToken: vi.fn(async () => ({ token: "a".repeat(43) })),
    resolveAccessToken: vi.fn(async () => null),
    ...overrides
  };
}

describe("OIDC authorization service", () => {
  it("issues a code immediately for an eligible Prism session", async () => {
    const oidcStore = store({ resolveEligiblePrismSessionIdentity: vi.fn(async () => identity) });

    const result = await authorizeOidcRequest({
      url: authorizationUrl(),
      sessionToken: "session-token",
      store: oidcStore,
      config,
      now
    });

    expect(result).toEqual({
      kind: "redirect",
      location: "https://playtest.example/api/auth/callback?code=authorization-code&state=state-123"
    });
    expect(oidcStore.issueAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({
      requestId: undefined,
      clientId: "shg-playtest",
      prismUserId: "prism-user-1",
      redirectUri: config.playtestClient.redirectUri,
      nonce: "nonce-123",
      scope: "openid profile email",
      codeChallenge: "c".repeat(43),
      now
    }));
    expect(oidcStore.createPendingAuthorizationRequest).not.toHaveBeenCalled();
  });

  it("persists the validated request and starts Slack login when no eligible session exists", async () => {
    const oidcStore = store();

    const result = await authorizeOidcRequest({
      url: authorizationUrl(),
      store: oidcStore,
      config,
      sourceIdentifier: "192.0.2.10",
      now
    });

    expect(result).toEqual({
      kind: "redirect",
      location: `https://prism.example/v1/slack/oauth/start?oidc_request=${"r".repeat(43)}`
    });
    expect(oidcStore.createPendingAuthorizationRequest).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "shg-playtest",
      redirectUri: config.playtestClient.redirectUri,
      state: "state-123",
      nonce: "nonce-123",
      sourceIdentifier: "192.0.2.10",
      expiresAt: new Date("2026-08-21T00:10:00.000Z")
    }));
  });

  it("returns 429 before session lookup or pending persistence when the shared limiter denies", async () => {
    const oidcStore = store({
      consumeAuthorizationRequestPermit: vi.fn(async () => ({ kind: "limited" as const, retryAfterSeconds: 42 }))
    });

    await expect(authorizeOidcRequest({
      url: authorizationUrl(),
      store: oidcStore,
      config,
      sourceIdentifier: "192.0.2.10",
      now
    })).resolves.toEqual({
      kind: "error", status: 429, error: "temporarily_unavailable", retryAfterSeconds: 42
    });

    expect(oidcStore.resolveEligiblePrismSessionIdentity).not.toHaveBeenCalled();
    expect(oidcStore.createPendingAuthorizationRequest).not.toHaveBeenCalled();
    expect(oidcStore.issueAuthorizationCode).not.toHaveBeenCalled();
  });

  it("returns 429 without inserting when the outstanding pending cap is reached", async () => {
    const oidcStore = store({
      createPendingAuthorizationRequest: vi.fn(async () => ({ kind: "limited" as const, retryAfterSeconds: 120 }))
    });

    await expect(authorizeOidcRequest({
      url: authorizationUrl(), store: oidcStore, config, now
    })).resolves.toEqual({
      kind: "error", status: 429, error: "temporarily_unavailable", retryAfterSeconds: 120
    });
    expect(oidcStore.issueAuthorizationCode).not.toHaveBeenCalled();
  });

  it("never redirects an invalid client or redirect URI", async () => {
    const result = await authorizeOidcRequest({
      url: authorizationUrl({ redirect_uri: "https://attacker.example/callback" }),
      store: store(),
      config,
      now
    });

    expect(result).toEqual({ kind: "error", status: 400, error: "invalid_request" });
  });

  it("resumes from persisted fields and atomically consumes the request when issuing a code", async () => {
    const pending = {
      requestId: "r".repeat(43),
      clientId: "shg-playtest",
      redirectUri: config.playtestClient.redirectUri,
      state: "stored-state",
      nonce: "stored-nonce",
      scope: "openid profile",
      codeChallenge: "s".repeat(43),
      codeChallengeMethod: "S256" as const,
      expiresAt: new Date("2026-08-21T00:09:00.000Z")
    };
    const oidcStore = store({
      loadPendingAuthorizationRequest: vi.fn(async () => pending),
      resolveEligiblePrismSessionIdentity: vi.fn(async () => identity)
    });

    const result = await authorizeOidcRequest({
      url: new URL(`https://prism.example/oauth/authorize?request=${pending.requestId}`),
      sessionToken: "session-token",
      store: oidcStore,
      config,
      now
    });

    expect(result).toEqual({
      kind: "redirect",
      location: "https://playtest.example/api/auth/callback?code=authorization-code&state=stored-state"
    });
    expect(oidcStore.issueAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({
      requestId: pending.requestId,
      prismUserId: identity.prismUserId,
      slackConnectionId: identity.slackConnectionId,
      now
    }));
  });

  it("consumes a cancelled pending request and returns only its stored callback and state", async () => {
    const pending = {
      requestId: "r".repeat(43), clientId: "shg-playtest", redirectUri: config.playtestClient.redirectUri,
      state: "stored-state", nonce: "stored-nonce", scope: "openid", codeChallenge: "s".repeat(43),
      codeChallengeMethod: "S256" as const, expiresAt: new Date("2026-08-21T00:09:00.000Z")
    };
    const oidcStore = store({ consumePendingAuthorizationRequest: vi.fn(async () => pending) });

    const result = await authorizeOidcRequest({
      url: new URL(`https://prism.example/oauth/authorize?request=${pending.requestId}&error=access_denied`),
      sessionToken: "ignored",
      store: oidcStore,
      config,
      now
    });

    expect(result).toEqual({
      kind: "redirect",
      location: "https://playtest.example/api/auth/callback?error=access_denied&state=stored-state"
    });
    expect(oidcStore.resolveEligiblePrismSessionIdentity).not.toHaveBeenCalled();
  });

  it("fails closed with login_required when the resumed Prism session is not eligible", async () => {
    const pending = {
      requestId: "r".repeat(43), clientId: "shg-playtest", redirectUri: config.playtestClient.redirectUri,
      state: "stored-state", nonce: "stored-nonce", scope: "openid", codeChallenge: "s".repeat(43),
      codeChallengeMethod: "S256" as const, expiresAt: new Date("2026-08-21T00:09:00.000Z")
    };
    const oidcStore = store({
      loadPendingAuthorizationRequest: vi.fn(async () => pending),
      consumePendingAuthorizationRequest: vi.fn(async () => pending)
    });

    const result = await authorizeOidcRequest({
      url: new URL(`https://prism.example/oauth/authorize?request=${pending.requestId}`),
      sessionToken: "expired-or-ineligible-session",
      store: oidcStore,
      config,
      now
    });

    expect(result).toEqual({
      kind: "redirect",
      location: "https://playtest.example/api/auth/callback?error=login_required&state=stored-state"
    });
    expect(oidcStore.consumePendingAuthorizationRequest).toHaveBeenCalledWith({ requestId: pending.requestId, now });
    expect(oidcStore.issueAuthorizationCode).not.toHaveBeenCalled();
  });

  it("fails a replayed or malformed resume handle without redirecting", async () => {
    const oidcStore = store();
    for (const requestId of ["short", "r".repeat(43)]) {
      await expect(authorizeOidcRequest({
        url: new URL(`https://prism.example/oauth/authorize?request=${requestId}`),
        store: oidcStore,
        config,
        now
      })).resolves.toEqual({ kind: "error", status: 400, error: "invalid_request" });
    }
  });
});

describe("OIDC token and UserInfo service", () => {
  it("exchanges a code once and signs identity claims sourced from Prism", async () => {
    const code = {
      prismUserId: identity.prismUserId,
      slackConnectionId: identity.slackConnectionId,
      clientId: "shg-playtest",
      redirectUri: config.playtestClient.redirectUri,
      nonce: "stored-nonce",
      scope: "openid profile email",
      codeChallenge: "unused",
      codeChallengeMethod: "S256" as const,
      authTime: identity.authTime
    };
    const accessIdentity = { ...identity, clientId: "shg-playtest", scope: code.scope };
    const oidcStore = store({
      exchangeAuthorizationCode: vi.fn(async () => ({ token: "a".repeat(43), authorizationCode: code })),
      resolveAccessToken: vi.fn(async () => accessIdentity)
    });
    const signing: OidcSigningService = {
      keyId: "kid",
      publicJwk: {},
      sign: vi.fn(async () => "signed-id-token")
    };
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "shg-playtest",
      redirect_uri: config.playtestClient.redirectUri,
      code: "authorization-code",
      code_verifier: "v".repeat(43)
    });

    const result = await exchangeOidcCode({ params, store: oidcStore, signing, config, now });

    expect(result).toEqual({
      kind: "success",
      body: {
        access_token: "a".repeat(43), token_type: "Bearer", expires_in: 300,
        scope: "openid profile email", id_token: "signed-id-token"
      }
    });
    expect(signing.sign).toHaveBeenCalledWith({
      iss: "https://prism.example", sub: "prism-user-1", aud: "shg-playtest", azp: "shg-playtest",
      iat: 1787270400, exp: 1787270700, auth_time: 1787270340, nonce: "stored-nonce",
      name: "Ada Lovelace", preferred_username: "Ada Lovelace",
      slack_user_id: "U123", slack_team_id: "T123", slack_enterprise_id: "E123"
    });

    oidcStore.exchangeAuthorizationCode = vi.fn(async () => null);
    await expect(exchangeOidcCode({ params, store: oidcStore, signing, config, now })).resolves.toEqual({
      kind: "error", status: 400, error: "invalid_grant"
    });
  });

  it("returns invalid_grant for a replay or PKCE mismatch without minting a token", async () => {
    const oidcStore = store();
    const result = await exchangeOidcCode({
      params: new URLSearchParams({
        grant_type: "authorization_code", client_id: "shg-playtest",
        redirect_uri: config.playtestClient.redirectUri, code: "authorization-code", code_verifier: "x".repeat(43)
      }),
      store: oidcStore,
      signing: { keyId: "kid", publicJwk: {}, sign: vi.fn() },
      config,
      now
    });

    expect(result).toEqual({ kind: "error", status: 400, error: "invalid_grant" });
    expect(oidcStore.exchangeAuthorizationCode).toHaveBeenCalledOnce();
    expect(oidcStore.issueAccessToken).not.toHaveBeenCalled();
  });

  it("keeps an openid-only ID token limited to standard authentication claims", async () => {
    const code = {
      prismUserId: identity.prismUserId,
      slackConnectionId: identity.slackConnectionId,
      clientId: "shg-playtest",
      redirectUri: config.playtestClient.redirectUri,
      nonce: "stored-nonce",
      scope: "openid",
      codeChallenge: "unused",
      codeChallengeMethod: "S256" as const,
      authTime: identity.authTime
    };
    const oidcStore = store({
      exchangeAuthorizationCode: vi.fn(async () => ({ token: "a".repeat(43), authorizationCode: code })),
      resolveAccessToken: vi.fn(async () => ({ ...identity, clientId: "shg-playtest", scope: "openid" }))
    });
    const sign = vi.fn(async () => "signed-id-token");
    const params = new URLSearchParams({
      grant_type: "authorization_code", client_id: "shg-playtest",
      redirect_uri: config.playtestClient.redirectUri, code: "authorization-code", code_verifier: "v".repeat(43)
    });

    await expect(exchangeOidcCode({
      params, store: oidcStore, signing: { keyId: "kid", publicJwk: {}, sign }, config, now
    })).resolves.toMatchObject({ kind: "success" });
    expect(sign).toHaveBeenCalledWith({
      iss: "https://prism.example", sub: "prism-user-1", aud: "shg-playtest", azp: "shg-playtest",
      iat: 1787270400, exp: 1787270700, auth_time: 1787270340, nonce: "stored-nonce"
    });
  });

  it("resolves strict bearer UserInfo with profile and Slack claims only for profile scope", async () => {
    const oidcStore = store({
      resolveAccessToken: vi.fn(async () => ({ ...identity, clientId: "shg-playtest", scope: "openid profile" }))
    });
    await expect(resolveOidcUserInfo({
      authorization: `Bearer ${"a".repeat(43)}`,
      store: oidcStore,
      config,
      now
    })).resolves.toEqual({
      kind: "success",
      body: {
        sub: "prism-user-1", name: "Ada Lovelace", preferred_username: "Ada Lovelace",
        slack_user_id: "U123", slack_team_id: "T123", slack_enterprise_id: "E123"
      }
    });
    await expect(resolveOidcUserInfo({
      authorization: `Bearer ${"a".repeat(43)}, second`, store: oidcStore, config, now
    })).resolves.toEqual({ kind: "error", status: 401, error: "invalid_token" });
  });

  it("returns only sub from UserInfo for openid-only or email-only identity grants", async () => {
    for (const scope of ["openid", "openid email"]) {
      const oidcStore = store({
        resolveAccessToken: vi.fn(async () => ({ ...identity, clientId: "shg-playtest", scope }))
      });
      await expect(resolveOidcUserInfo({
        authorization: `Bearer ${"a".repeat(43)}`, store: oidcStore, config, now
      })).resolves.toEqual({ kind: "success", body: { sub: "prism-user-1" } });
    }
  });
});
