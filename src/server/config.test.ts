import { describe, expect, it } from "vitest";

import { generateKeyPairSync } from "node:crypto";

import {
  getCredentialEncryptionConfig,
  getDatabaseUrl,
  getDelegatedDeliveryConfig,
  getDelegatedDeliveryMaintenanceConfig,
  getDeveloperTokenConfig,
  getOidcProviderConfig,
  getSlackOAuthConfig,
  getSlackOAuthEnvironmentBundle,
  getSetupAbuseProtectionConfig,
  getSlackWebApiConfig,
  isSetupRequiredError
} from "./config";

describe("server setup config", () => {
  it("keeps delegated Slack delivery disabled without loading any registration or secret", () => {
    expect(
      getDelegatedDeliveryConfig({
        NODE_ENV: "test",
        PRISM_DELEGATED_SLACK_DELIVERY_ENABLED: "0",
        PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER: "replace-with-secret-canary"
      })
    ).toEqual({ enabled: false });
    expect(getDelegatedDeliveryConfig({ NODE_ENV: "test" })).toEqual({ enabled: false });
  });

  it("loads the exact delegated Playtest registration and bounded defaults", () => {
    expect(getDelegatedDeliveryConfig(delegatedDeliveryEnv())).toMatchObject({
      enabled: true,
      issuer: "http://localhost:3732",
      clientId: "shg-playtest-delegation",
      callbackUri: "http://localhost:3847/api/announcements/delegation/callback",
      clientJwks: [{ kty: "EC", crv: "P-256", alg: "ES256", kid: "playtest-es256-v1" }],
      grantPepperId: "delegated-grants-v1",
      allowInsecureHttp: true,
      trustProxyHeaders: false,
      limits: {
        approvalTtlMs: 600_000,
        authorizationCodeTtlMs: 300_000,
        maxScheduleHorizonMs: 2_592_000_000,
        grantTtlMs: 1_800_000,
        statusRetentionMs: 2_592_000_000,
        proofClockSkewSeconds: 60,
        proofLifetimeSeconds: 60,
        rateWindowMs: 60_000,
        maxRequestsPerSource: 30,
        maxRequestsPerClient: 300,
        maxRequestsPerUser: 30,
        maxRequestsPerChannel: 60,
        maxOutstandingPendingPerSource: 10,
        maxOutstandingPendingPerClient: 500,
        maxOutstandingPendingPerUser: 20,
        cleanupBatchSize: 100
      }
    });
  });

  it("rejects a broadened delegated registration, private JWK material, or shared pepper", () => {
    const base = delegatedDeliveryEnv();
    expect(() =>
      getDelegatedDeliveryConfig({ ...base, PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID: "another-client" })
    ).toThrow("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID");

    const jwks = JSON.parse(base.PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS!) as { keys: Array<Record<string, unknown>> };
    jwks.keys[0]!.d = "private-key-secret-canary";
    try {
      getDelegatedDeliveryConfig({
        ...base,
        PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS: JSON.stringify(jwks)
      });
      throw new Error("expected delegated JWK validation to fail");
    } catch (error) {
      expect(String(error)).toBe("Error: setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS");
      expect(String(error)).not.toContain("private-key-secret-canary");
    }

    expect(() =>
      getDelegatedDeliveryConfig({
        ...base,
        PRISM_DEVELOPER_TOKEN_PEPPER: base.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER
      })
    ).toThrow("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_DISTINCT");
    expect(() =>
      getDelegatedDeliveryConfig({
        ...base,
        PRISM_DEVELOPER_TOKEN_PEPPER_ID: base.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID
      })
    ).toThrow("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID_DISTINCT");
  });

  it("allows opted-in private HTTP delegation in production and enforces timing and abuse caps", () => {
    const base = delegatedDeliveryEnv();
    expect(
      getDelegatedDeliveryConfig({
        ...base,
        NODE_ENV: "production",
        PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP: "1"
      })
    ).toMatchObject({ enabled: true, allowInsecureHttp: true });
    expect(() =>
      getDelegatedDeliveryConfig({
        ...base,
        NODE_ENV: "production",
        PRISM_PUBLIC_BASE_URL: "http://example.com:3732",
        PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP: "1"
      })
    ).toThrow("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP");
    expect(() =>
      getDelegatedDeliveryConfig({
        ...base,
        PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI:
          "http://localhost:3847/api/announcements/delegation/callback?next=untrusted"
      })
    ).toThrow("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI");
    expect(() =>
      getDelegatedDeliveryConfig({
        ...base,
        PRISM_DELEGATED_SLACK_DELIVERY_APPROVAL_TTL_SECONDS: "601"
      })
    ).toThrow("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_APPROVAL_TTL_SECONDS");
    expect(() =>
      getDelegatedDeliveryConfig({
        ...base,
        PRISM_DELEGATED_SLACK_DELIVERY_APPROVAL_TTL_SECONDS: "300",
        PRISM_DELEGATED_SLACK_DELIVERY_GRANT_TTL_SECONDS: "300"
      })
    ).toThrow("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_TIMING_LIMITS");
    expect(() =>
      getDelegatedDeliveryConfig({
        ...base,
        PRISM_DELEGATED_SLACK_DELIVERY_RATE_LIMIT_PER_SOURCE: "50",
        PRISM_DELEGATED_SLACK_DELIVERY_RATE_LIMIT_PER_CLIENT: "10"
      })
    ).toThrow("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_ABUSE_PROTECTION_LIMITS");
  });

  it("enables delegated forwarding headers only with the dedicated opt-in", () => {
    const base = delegatedDeliveryEnv();
    expect(getDelegatedDeliveryConfig(base)).toMatchObject({
      enabled: true,
      trustProxyHeaders: false
    });
    expect(getDelegatedDeliveryConfig({
      ...base,
      PRISM_DELEGATED_SLACK_DELIVERY_TRUST_PROXY_HEADERS: "1"
    })).toMatchObject({ enabled: true, trustProxyHeaders: true });
    expect(getDelegatedDeliveryConfig({
      ...base,
      PRISM_DELEGATED_SLACK_DELIVERY_TRUST_PROXY_HEADERS: "yes"
    })).toMatchObject({ enabled: true, trustProxyHeaders: false });
  });

  it("loads bounded cleanup settings without enabling or loading delegation secrets", () => {
    expect(getDelegatedDeliveryMaintenanceConfig({
      PRISM_DELEGATED_SLACK_DELIVERY_STATUS_RETENTION_SECONDS: "3600",
      PRISM_DELEGATED_SLACK_DELIVERY_CLEANUP_BATCH_SIZE: "25",
      PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER: "cleanup-secret-canary"
    })).toEqual({ statusRetentionMs: 3_600_000, cleanupBatchSize: 25 });
    expect(() => getDelegatedDeliveryMaintenanceConfig({
      PRISM_DELEGATED_SLACK_DELIVERY_CLEANUP_BATCH_SIZE: "1001"
    })).toThrow("setup-required:PRISM_DELEGATED_SLACK_DELIVERY_CLEANUP_BATCH_SIZE");
  });

  it("derives the local database URL from canonical Postgres fields", () => {
    expect(
      getDatabaseUrl({
        POSTGRES_USER: "prism user",
        POSTGRES_PASSWORD: "local password",
        POSTGRES_DB: "prism-db",
        POSTGRES_HOST: "localhost",
        POSTGRES_PORT: "5433"
      })
    ).toBe("postgres://prism%20user:local%20password@localhost:5433/prism-db");
  });

  it("throws sanitized setup-required errors without echoing missing secret values", () => {
    expect(() => getSlackOAuthConfig({ SLACK_CLIENT_ID: "replace-with-client", SLACK_CLIENT_SECRET: "super-secret-canary" })).toThrow(
      "setup-required:SLACK_OAUTH_CREDENTIAL_PAIR"
    );

    try {
      getCredentialEncryptionConfig({ PRISM_CREDENTIAL_ENCRYPTION_KEY: "replace-with-key", PRISM_CREDENTIAL_ENCRYPTION_KEY_ID: "local" });
    } catch (error) {
      expect(isSetupRequiredError(error)).toBe(true);
      expect(String(error)).not.toContain("super-secret-canary");
      expect(String(error)).not.toContain("replace-with-key");
    }
  });

  it("loads developer token verifier config without echoing pepper values", () => {
    expect(getDeveloperTokenConfig({ PRISM_DEVELOPER_TOKEN_PEPPER: "pepper-secret-canary" })).toEqual({
      pepper: "pepper-secret-canary",
      pepperId: "local-dev-pepper-v1"
    });

    try {
      getDeveloperTokenConfig({ PRISM_DEVELOPER_TOKEN_PEPPER: "replace-with-pepper-secret-canary" });
    } catch (error) {
      expect(isSetupRequiredError(error)).toBe(true);
      expect(String(error)).toBe("Error: setup-required:PRISM_DEVELOPER_TOKEN_PEPPER");
      expect(String(error)).not.toContain("pepper-secret-canary");
    }
  });

  it("defaults Slack Web API forwarding to real mode and requires explicit non-production mock mode", () => {
    expect(getSlackWebApiConfig({})).toEqual({ mockWebApi: false });
    expect(getSlackWebApiConfig({ PRISM_SLACK_WEB_API_MOCK: "1", NODE_ENV: "development" })).toEqual({ mockWebApi: true });
    expect(getSlackWebApiConfig({ PRISM_SLACK_WEB_API_MOCK: "1", NODE_ENV: "production" })).toEqual({ mockWebApi: false });
  });

  it("trusts setup forwarding headers only after the exact deployment opt-in", () => {
    expect(getSetupAbuseProtectionConfig({ NODE_ENV: "test" })).toEqual({ trustProxyHeaders: false });
    expect(getSetupAbuseProtectionConfig({ NODE_ENV: "test", PRISM_SETUP_TRUST_PROXY_HEADERS: "yes" })).toEqual({
      trustProxyHeaders: false
    });
    expect(getSetupAbuseProtectionConfig({ NODE_ENV: "test", PRISM_SETUP_TRUST_PROXY_HEADERS: "1" })).toEqual({
      trustProxyHeaders: true
    });
  });

  it("defaults an omitted Slack scope selection to every reviewed Prism-supported scope", () => {
    const base = {
      NODE_ENV: "development",
      SLACK_CLIENT_ID: "client-id",
      SLACK_CLIENT_SECRET: "secret-canary",
      PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
      PRISM_OIDC_ALLOW_INSECURE_HTTP: "1"
    };

    expect(getSlackOAuthConfig(base)).toMatchObject({
      botScopes: expect.arrayContaining(["channels:read", "chat:write", "users:read"]),
      userScopes: expect.arrayContaining(["channels:read", "chat:write", "search:read"]),
      mockOAuth: false
    });
    expect(
      getSlackOAuthConfig({ ...base, SLACK_USER_SCOPES: "users:read,chat:write" })
    ).toMatchObject({ botScopes: [], userScopes: ["chat:write", "users:read"], mockOAuth: false });
    expect(
      getSlackOAuthConfig({
        ...base,
        PRISM_SLACK_OAUTH_MOCK: "1",
        SLACK_BOT_SCOPES: "",
        SLACK_USER_SCOPES: "users:read"
      })
    ).toMatchObject({
      botScopes: expect.arrayContaining(["channels:read", "chat:write", "users:read"]),
      userScopes: expect.arrayContaining(["channels:read", "chat:write", "search:read"]),
      mockOAuth: true
    });
  });

  it("parses the legacy environment credentials as one authoritative bundle", () => {
    const deployment = {
      NODE_ENV: "development",
      PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
      PRISM_OIDC_ALLOW_INSECURE_HTTP: "1"
    };
    expect(getSlackOAuthEnvironmentBundle(deployment)).toBeNull();
    expect(() => getSlackOAuthEnvironmentBundle({ ...deployment, SLACK_CLIENT_ID: "client-id" })).toThrow(
      "setup-required:SLACK_OAUTH_CREDENTIAL_PAIR"
    );
    expect(() => getSlackOAuthEnvironmentBundle({
      ...deployment,
      SLACK_CLIENT_SECRET: "secret-canary"
    })).toThrow("setup-required:SLACK_OAUTH_CREDENTIAL_PAIR");

    expect(getSlackOAuthEnvironmentBundle({
      ...deployment,
      SLACK_CLIENT_ID: "client-id",
      SLACK_CLIENT_SECRET: "secret-canary",
      SLACK_USER_SCOPES: "chat:write,channels:read",
      SLACK_BOT_SCOPES: ""
    })).toMatchObject({
      botScopes: [],
      userScopes: ["channels:read", "chat:write"]
    });

    expect(() => getSlackOAuthEnvironmentBundle({
      ...deployment,
      SLACK_CLIENT_ID: "client-id",
      SLACK_CLIENT_SECRET: "secret-canary",
      SLACK_BOT_SCOPES: "chat:write"
    })).toThrow("setup-required:SLACK_OAUTH_SCOPES");
    expect(() => getSlackOAuthEnvironmentBundle({
      ...deployment,
      SLACK_CLIENT_ID: "client-id",
      SLACK_CLIENT_SECRET: "secret-canary",
      SLACK_USER_SCOPES: "chat:write,admin.secret-canary"
    })).toThrow("setup-required:SLACK_OAUTH_SCOPES");
  });

  it("treats only the reserved local mock as absent in production without echoing credentials", () => {
    const production: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      SLACK_CLIENT_ID: "33336676.569200954261",
      SLACK_CLIENT_SECRET: "production-client-secret-canary",
      PRISM_PUBLIC_BASE_URL: "https://prism.invalid",
      SLACK_OAUTH_REDIRECT_URI: "https://prism.invalid/v1/slack/oauth/callback",
      SLACK_USER_SCOPES: "chat:write,users:read"
    };

    const reservedMock = {
      ...production,
      SLACK_CLIENT_ID: "mock-playtest-client",
      PRISM_SLACK_OAUTH_MOCK: "1"
    };
    expect(getSlackOAuthEnvironmentBundle(reservedMock)).toBeNull();
    expect(getSlackOAuthEnvironmentBundle({
      NODE_ENV: "production",
      PRISM_SLACK_OAUTH_MOCK: "1"
    })).toBeNull();
    expect(() => getSlackOAuthConfig(reservedMock)).toThrow(
      "setup-required:SLACK_CLIENT_ID"
    );

    expect(() => getSlackOAuthConfig({ ...production, PRISM_SLACK_OAUTH_MOCK: "1" })).toThrow(
      "setup-required:PRISM_SLACK_OAUTH_MOCK"
    );
    expect(() => getSlackOAuthEnvironmentBundle({
      ...production,
      SLACK_CLIENT_SECRET: undefined,
      PRISM_SLACK_OAUTH_MOCK: "1"
    })).toThrow("setup-required:SLACK_OAUTH_CREDENTIAL_PAIR");
    expect(() => getSlackOAuthEnvironmentBundle({
      ...production,
      SLACK_CLIENT_ID: undefined,
      PRISM_SLACK_OAUTH_MOCK: "1"
    })).toThrow("setup-required:SLACK_OAUTH_CREDENTIAL_PAIR");
    expect(String(captureError(() => getSlackOAuthConfig(reservedMock))))
      .not.toMatch(/production-client-secret-canary|mock-playtest-client/);
    expect(getSlackOAuthEnvironmentBundle({
      ...reservedMock,
      PRISM_SLACK_OAUTH_MOCK: "0"
    })).toBeNull();
    expect(getSlackOAuthConfig(production)).toMatchObject({
      clientId: "33336676.569200954261",
      mockOAuth: false
    });
  });

  it("rejects a production mock flag paired with a non-reserved real client", () => {
    const production: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      SLACK_CLIENT_ID: "33336676.569200954261",
      SLACK_CLIENT_SECRET: "production-client-secret-canary",
      PRISM_PUBLIC_BASE_URL: "https://prism.invalid",
      SLACK_OAUTH_REDIRECT_URI: "https://prism.invalid/v1/slack/oauth/callback",
      SLACK_USER_SCOPES: "chat:write,users:read",
      PRISM_SLACK_OAUTH_MOCK: "1"
    };

    expect(() => getSlackOAuthEnvironmentBundle(production)).toThrow(
      "setup-required:PRISM_SLACK_OAUTH_MOCK"
    );
    expect(String(captureError(() => getSlackOAuthEnvironmentBundle(production))))
      .not.toContain("production-client-secret-canary");
  });

  it("loads one strict Playtest OIDC client and derives the issuer from the public base URL", () => {
    expect(
      getOidcProviderConfig({
        NODE_ENV: "development",
        PRISM_PUBLIC_BASE_URL: "http://localhost:3732/",
        PRISM_OIDC_ALLOW_INSECURE_HTTP: "1",
        PRISM_OIDC_PLAYTEST_CLIENT_ID: "shg-playtest",
        PRISM_OIDC_PLAYTEST_REDIRECT_URI: "http://localhost:3847/api/auth/callback",
        PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64: Buffer.from("-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----").toString("base64"),
        PRISM_OIDC_SIGNING_KEY_ID: "local-rs256-v1"
      })
    ).toMatchObject({
      issuer: "http://localhost:3732",
      playtestClient: {
        clientId: "shg-playtest",
        redirectUri: "http://localhost:3847/api/auth/callback",
        tokenEndpointAuthMethod: "none"
      },
      signing: { keyId: "local-rs256-v1" },
      allowInsecureHttp: true,
      abuseProtection: {
        authorizeWindowMs: 60_000,
        maxAuthorizeRequestsPerSource: 30,
        maxAuthorizeRequestsPerClient: 300,
        maxOutstandingPendingPerSource: 10,
        maxOutstandingPendingPerClient: 500,
        cleanupBatchSize: 100,
        trustProxyHeaders: false
      }
    });
  });

  it("loads bounded OIDC abuse-control overrides and fails closed on contradictory limits", () => {
    const base = {
      NODE_ENV: "development",
      PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
      PRISM_OIDC_ALLOW_INSECURE_HTTP: "1",
      PRISM_OIDC_PLAYTEST_CLIENT_ID: "shg-playtest",
      PRISM_OIDC_PLAYTEST_REDIRECT_URI: "http://localhost:3847/api/auth/callback",
      PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64: Buffer.from("-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----").toString("base64"),
      PRISM_OIDC_SIGNING_KEY_ID: "local-rs256-v1"
    };

    expect(getOidcProviderConfig({
      ...base,
      PRISM_OIDC_AUTHORIZE_RATE_WINDOW_SECONDS: "120",
      PRISM_OIDC_AUTHORIZE_RATE_LIMIT_PER_SOURCE: "40",
      PRISM_OIDC_AUTHORIZE_RATE_LIMIT_PER_CLIENT: "400",
      PRISM_OIDC_AUTHORIZE_MAX_OUTSTANDING_PER_SOURCE: "12",
      PRISM_OIDC_AUTHORIZE_MAX_OUTSTANDING_PER_CLIENT: "600",
      PRISM_OIDC_CLEANUP_BATCH_SIZE: "75",
      PRISM_OIDC_TRUST_PROXY_HEADERS: "1"
    }).abuseProtection).toEqual({
      authorizeWindowMs: 120_000,
      maxAuthorizeRequestsPerSource: 40,
      maxAuthorizeRequestsPerClient: 400,
      maxOutstandingPendingPerSource: 12,
      maxOutstandingPendingPerClient: 600,
      cleanupBatchSize: 75,
      trustProxyHeaders: true
    });
    expect(() => getOidcProviderConfig({
      ...base,
      PRISM_OIDC_AUTHORIZE_RATE_LIMIT_PER_SOURCE: "50",
      PRISM_OIDC_AUTHORIZE_RATE_LIMIT_PER_CLIENT: "10"
    })).toThrow("setup-required:PRISM_OIDC_ABUSE_PROTECTION_LIMITS");
  });

  it("requires an explicit HTTP opt-in and allows private HTTP in production", () => {
    const base = {
      PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
      PRISM_OIDC_PLAYTEST_CLIENT_ID: "shg-playtest",
      PRISM_OIDC_PLAYTEST_REDIRECT_URI: "http://localhost:3847/api/auth/callback",
      PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64: Buffer.from(
        "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----"
      ).toString("base64"),
      PRISM_OIDC_SIGNING_KEY_ID: "local-rs256-v1"
    };

    expect(() => getOidcProviderConfig({ ...base, NODE_ENV: "development" })).toThrow(
      "setup-required:PRISM_OIDC_ALLOW_INSECURE_HTTP"
    );
    expect(
      getOidcProviderConfig({
        ...base,
        NODE_ENV: "production",
        PRISM_OIDC_ALLOW_INSECURE_HTTP: "1"
      })
    ).toMatchObject({ issuer: "http://localhost:3732", allowInsecureHttp: true });
  });

  it("canonicalizes and validates Slack public and callback URLs using the same HTTP policy", () => {
    const base = {
      NODE_ENV: "development",
      SLACK_CLIENT_ID: "client-id",
      SLACK_CLIENT_SECRET: "secret-canary",
      SLACK_USER_SCOPES: "chat:write,users:read",
      PRISM_PUBLIC_BASE_URL: "http://localhost:3732/",
      SLACK_OAUTH_REDIRECT_URI: "http://localhost:3732/v1/slack/oauth/callback?ignored=1",
      PRISM_OIDC_ALLOW_INSECURE_HTTP: "1"
    };

    expect(() => getSlackOAuthConfig(base)).toThrow("setup-required:SLACK_OAUTH_REDIRECT_URI");
    expect(getSlackOAuthConfig({ ...base, SLACK_OAUTH_REDIRECT_URI: "http://localhost:3732/v1/slack/oauth/callback" })).toMatchObject({
      publicBaseUrl: "http://localhost:3732",
      redirectUri: "http://localhost:3732/v1/slack/oauth/callback"
    });
    expect(() => getSlackOAuthConfig({ ...base, PRISM_OIDC_ALLOW_INSECURE_HTTP: undefined })).toThrow(
      "setup-required:PRISM_OIDC_ALLOW_INSECURE_HTTP"
    );
    expect(getSlackOAuthConfig({
      ...base,
      NODE_ENV: "production",
      PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
      SLACK_OAUTH_REDIRECT_URI: "http://localhost:3732/v1/slack/oauth/callback"
    })).toMatchObject({
      publicBaseUrl: "http://localhost:3732",
      redirectUri: "http://localhost:3732/v1/slack/oauth/callback"
    });
    expect(() => getSlackOAuthConfig({ ...base, PRISM_PUBLIC_BASE_URL: "https://prism.example", SLACK_OAUTH_REDIRECT_URI: "http://example.com:3732/v1/slack/oauth/callback" })).toThrow(
      "setup-required:PRISM_OIDC_ALLOW_INSECURE_HTTP"
    );
    expect(() => getSlackOAuthConfig({ ...base, PRISM_PUBLIC_BASE_URL: "http://example.com:3732", SLACK_OAUTH_REDIRECT_URI: "http://example.com:3732/v1/slack/oauth/callback" })).toThrow(
      "setup-required:PRISM_OIDC_ALLOW_INSECURE_HTTP"
    );
  });

  it("accepts loopback and RFC1918 HTTP hosts only with the documented flag", () => {
    const base = {
      NODE_ENV: "development",
      PRISM_OIDC_ALLOW_INSECURE_HTTP: "1",
      PRISM_OIDC_PLAYTEST_CLIENT_ID: "shg-playtest",
      PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64: Buffer.from("-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----").toString("base64"),
      PRISM_OIDC_SIGNING_KEY_ID: "local-rs256-v1"
    };

    expect(
      getOidcProviderConfig({
        ...base,
        PRISM_PUBLIC_BASE_URL: "http://10.62.240.10:3732",
        PRISM_OIDC_PLAYTEST_REDIRECT_URI: "http://localhost:3847/api/auth/callback"
      })
    ).toMatchObject({ issuer: "http://10.62.240.10:3732", allowInsecureHttp: true });
    expect(() =>
      getOidcProviderConfig({
        ...base,
        PRISM_PUBLIC_BASE_URL: "http://example.com:3732",
        PRISM_OIDC_PLAYTEST_REDIRECT_URI: "http://localhost:3847/api/auth/callback"
      })
    ).toThrow("setup-required:PRISM_OIDC_ALLOW_INSECURE_HTTP");
    expect(() =>
      getOidcProviderConfig({
        ...base,
        PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
        PRISM_OIDC_PLAYTEST_REDIRECT_URI: "http://example.com:3847/api/auth/callback"
      })
    ).toThrow("setup-required:PRISM_OIDC_ALLOW_INSECURE_HTTP");
  });

  it("does not recognize an undocumented insecure HTTP alias", () => {
    expect(() =>
      getOidcProviderConfig({
        NODE_ENV: "development",
        PRISM_OIDC_ALLOW_HTTP: "1",
        PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
        PRISM_OIDC_PLAYTEST_CLIENT_ID: "shg-playtest",
        PRISM_OIDC_PLAYTEST_REDIRECT_URI: "http://localhost:3847/api/auth/callback",
        PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64: "a2V5",
        PRISM_OIDC_SIGNING_KEY_ID: "local-rs256-v1"
      })
    ).toThrow("setup-required:PRISM_OIDC_ALLOW_INSECURE_HTTP");
  });

  it("rejects malformed origins and redirect URLs without echoing key material", () => {
    const secret = "private-key-secret-canary";
    expect(() =>
      getOidcProviderConfig({
        NODE_ENV: "development",
        PRISM_PUBLIC_BASE_URL: "https://user:password@example.com/path?x=1",
        PRISM_OIDC_PLAYTEST_CLIENT_ID: "shg-playtest",
        PRISM_OIDC_PLAYTEST_REDIRECT_URI: "https://playtest.example/callback",
        PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64: secret,
        PRISM_OIDC_SIGNING_KEY_ID: "kid"
      })
    ).toThrow("setup-required:PRISM_PUBLIC_BASE_URL");
    try {
      getOidcProviderConfig({
        NODE_ENV: "production",
        PRISM_PUBLIC_BASE_URL: "https://prism.example",
        PRISM_OIDC_PLAYTEST_CLIENT_ID: "shg-playtest",
        PRISM_OIDC_PLAYTEST_REDIRECT_URI: "https://playtest.example/callback#fragment",
        PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64: secret,
        PRISM_OIDC_SIGNING_KEY_ID: "kid"
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

function delegatedDeliveryEnv(): NodeJS.ProcessEnv {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" });
  return {
    NODE_ENV: "development",
    PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
    PRISM_DELEGATED_SLACK_DELIVERY_ENABLED: "1",
    PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP: "1",
    PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID: "shg-playtest-delegation",
    PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI:
      "http://localhost:3847/api/announcements/delegation/callback",
    PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS: JSON.stringify({
      keys: [
        {
          kty: "EC",
          crv: "P-256",
          alg: "ES256",
          kid: "playtest-es256-v1",
          x: publicJwk.x,
          y: publicJwk.y,
          use: "sig",
          key_ops: ["verify"]
        }
      ]
    }),
    PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER: "delegated-grant-pepper-secret-canary-32-bytes",
    PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID: "delegated-grants-v1"
  };
}

function captureError(callback: () => unknown): unknown {
  try {
    callback();
    throw new Error("expected callback to throw");
  } catch (error) {
    return error;
  }
}
