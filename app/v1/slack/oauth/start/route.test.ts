import { generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({ query: vi.fn<() => Promise<unknown>>() }));

vi.mock("../../../../../src/server/db", () => ({ database: mockDb }));

describe("GET /v1/slack/oauth/start", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    clearDelegatedDeliveryEnv();
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.PRISM_SLACK_OAUTH_MOCK;
    process.env.SLACK_CLIENT_ID = "client-id-123";
    process.env.SLACK_CLIENT_SECRET = "client-secret-must-not-appear";
    process.env.PRISM_PUBLIC_BASE_URL = "http://localhost:3732";
    process.env.PRISM_OIDC_ALLOW_INSECURE_HTTP = "1";
    process.env.SLACK_OAUTH_REDIRECT_URI = "http://localhost:3732/v1/slack/oauth/callback";
    process.env.SLACK_USER_SCOPES = "users:read,chat:write";
    process.env.PRISM_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.PRISM_CREDENTIAL_ENCRYPTION_KEY_ID = "oauth-start-test-key";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects to Slack authorize with state cookie and no client secret", async () => {
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const { GET } = await import("./route");

    const response = await GET();
    const location = response.headers.get("location") ?? "";
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(location).toContain("https://slack.com/oauth/v2/authorize");
    expect(location).toContain("client_id=client-id-123");
    expect(location).toContain("state=");
    expect(cookie).toContain("prism_slack_oauth_state=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(`${location} ${cookie}`).not.toContain("client-secret-must-not-appear");
  });

  it.each([
    {
      label: "an explicitly requested OAuth mock",
      resolvesDatabaseFallback: false,
      configure: () => {
        process.env.PRISM_SLACK_OAUTH_MOCK = "1";
      }
    },
    {
      label: "the reserved mock client id with mock mode disabled",
      resolvesDatabaseFallback: true,
      configure: () => {
        process.env.SLACK_CLIENT_ID = "mock-playtest-client";
        process.env.PRISM_SLACK_OAUTH_MOCK = "0";
      }
    }
  ])("fails closed for production $label", async ({ configure, resolvesDatabaseFallback }) => {
    vi.stubEnv("NODE_ENV", "production");
    configure();
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { GET } = await import("./route");

    const response = await GET();
    const location = response.headers.get("location") ?? "";
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(location).toBe("http://localhost:3732/?slack=setup_required");
    expect(location).not.toContain("slack.com");
    expect(cookie).not.toContain("prism_slack_oauth_state=");
    if (resolvesDatabaseFallback) {
      expect(mockDb.query).toHaveBeenCalled();
    } else {
      expect(mockDb.query).not.toHaveBeenCalled();
    }
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the production real-client authorize contract after config validation", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SLACK_CLIENT_ID = "33336676.569200954261";
    process.env.PRISM_SLACK_OAUTH_MOCK = "0";
    process.env.PRISM_PUBLIC_BASE_URL = "https://prism.invalid";
    process.env.SLACK_OAUTH_REDIRECT_URI = "https://prism.invalid/v1/slack/oauth/callback";
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const { GET } = await import("./route");

    const response = await GET();
    const location = response.headers.get("location") ?? "";

    expect(response.status).toBe(302);
    expect(location).toContain("https://slack.com/oauth/v2/authorize");
    expect(location).toContain("client_id=33336676.569200954261");
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("binds only a well-formed opaque OIDC request id into the stored Slack state", async () => {
    const oidcRequestId = "r".repeat(43);
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest(`http://localhost:3732/v1/slack/oauth/start?oidc_request=${oidcRequestId}`)
    );

    expect(response.status).toBe(302);
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("oidc_authorization_request_id"),
      expect.arrayContaining([oidcRequestId])
    );
  });

  it("rejects a delegated continuation before OAuth state persistence while the feature is disabled", async () => {
    const { GET } = await import("./route");
    const requestId = "ddr_12345678-1234-4123-8123-123456789012";

    const response = await GET(new NextRequest(
      `http://localhost:3732/v1/slack/oauth/start?delegation_request=${requestId}`
    ));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:3732/?slack=error");
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("stores one typed delegated continuation when the feature is enabled", async () => {
    enableDelegatedDelivery();
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const { GET } = await import("./route");
    const requestId = "ddr_12345678-1234-4123-8123-123456789012";

    const response = await GET(new NextRequest(
      `http://localhost:3732/v1/slack/oauth/start?delegation_request=${requestId}`
    ));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://slack.com/oauth/v2/authorize");
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("delegated_delivery_request_id"),
      expect.arrayContaining([requestId])
    );
  });
});

function clearDelegatedDeliveryEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PRISM_DELEGATED_SLACK_DELIVERY_")) delete process.env[key];
  }
}

function enableDelegatedDelivery(): void {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" });
  process.env.PRISM_DELEGATED_SLACK_DELIVERY_ENABLED = "1";
  process.env.PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP = "1";
  process.env.PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID = "shg-playtest-delegation";
  process.env.PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI = "http://localhost:3847/api/announcements/delegation/callback";
  process.env.PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS = JSON.stringify({
    keys: [{
      kty: "EC", crv: "P-256", alg: "ES256", kid: "playtest-es256-v1",
      x: publicJwk.x, y: publicJwk.y, use: "sig", key_ops: ["verify"]
    }]
  });
  process.env.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER = "delegated-grant-pepper-secret-canary-32-bytes";
  process.env.PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID = "delegated-grants-v1";
}
