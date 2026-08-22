import { generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn()
}));

vi.mock("../../../../../src/server/db", () => ({ database: mockDb }));

describe("GET /v1/slack/oauth/callback", () => {
  beforeEach(() => {
    vi.resetModules();
    clearDelegatedDeliveryEnv();
    vi.stubEnv("NODE_ENV", "development");
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (callback) => callback(mockDb));
    process.env.SLACK_CLIENT_ID = "client-id-123";
    process.env.SLACK_CLIENT_SECRET = "client-secret-must-not-appear";
    process.env.PRISM_PUBLIC_BASE_URL = "http://localhost:3732";
    process.env.PRISM_OIDC_ALLOW_INSECURE_HTTP = "1";
    process.env.SLACK_OAUTH_REDIRECT_URI = "http://localhost:3732/v1/slack/oauth/callback";
    process.env.PRISM_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
    process.env.PRISM_CREDENTIAL_ENCRYPTION_KEY_ID = "test-key";
    process.env.PRISM_SLACK_OAUTH_MOCK = "1";
    process.env.SLACK_USER_SCOPES = "search:read";
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("update slack_oauth_states")) return { rows: [{ redirect_uri: "http://localhost:3732/v1/slack/oauth/callback" }], rowCount: 1 };
      if (sql.includes("insert into prism_users")) return { rows: [{ id: "user_1" }], rowCount: 1 };
      if (sql.includes("insert into slack_connections")) return { rows: [{ id: "conn_1" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exchanges a valid callback through the server path and redirects without token-bearing params", async () => {
    const { GET } = await import("./route");
    const request = new NextRequest("http://localhost:3732/v1/slack/oauth/callback?code=mock-code&state=state-123", {
      headers: { cookie: "prism_slack_oauth_state=state-123" }
    });

    const response = await GET(request);
    const location = response.headers.get("location") ?? "";
    const cookie = response.headers.get("set-cookie") ?? "";
    const visible = `${location} ${cookie}`;

    expect(response.status).toBe(302);
    expect(location).toBe("http://localhost:3732/?slack=linked");
    expect(cookie).toContain("prism_session=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(visible).not.toMatch(/xox[bp]-|refresh-secret|access_token|client-secret/i);
  });

  it("fails closed before callback persistence when OAuth mock mode reaches production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { GET } = await import("./route");
    const request = new NextRequest("http://localhost:3732/v1/slack/oauth/callback?code=mock-code&state=state-123", {
      headers: { cookie: "prism_slack_oauth_state=state-123" }
    });

    const response = await GET(request);
    const location = response.headers.get("location") ?? "";
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(location).toBe("http://localhost:3732/?slack=setup_required");
    expect(location).not.toContain("slack.com");
    expect(cookie).toContain("prism_slack_oauth_state=");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("clears the Slack state cookie and disables caching when callback persistence fails", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("database unavailable"));
    const { GET } = await import("./route");
    const request = new NextRequest("http://localhost:3732/v1/slack/oauth/callback?code=mock-code&state=state-123", {
      headers: { cookie: "prism_slack_oauth_state=state-123" }
    });

    const response = await GET(request);
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(cookie).toContain("prism_slack_oauth_state=");
    expect(cookie.toLowerCase()).toMatch(/max-age=0|expires=/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("automatically resumes the bound OIDC request after Slack creates the Prism session", async () => {
    const oidcRequestId = "r".repeat(43);
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("update slack_oauth_states")) {
        return {
          rows: [{
            redirect_uri: "http://localhost:3732/v1/slack/oauth/callback",
            oidc_authorization_request_id: oidcRequestId
          }],
          rowCount: 1
        };
      }
      if (sql.includes("insert into prism_users")) return { rows: [{ id: "user_1" }], rowCount: 1 };
      if (sql.includes("insert into slack_connections")) return { rows: [{ id: "conn_1" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const { GET } = await import("./route");
    const request = new NextRequest("http://localhost:3732/v1/slack/oauth/callback?code=mock-code&state=state-123", {
      headers: { cookie: "prism_slack_oauth_state=state-123" }
    });

    const response = await GET(request);

    expect(response.headers.get("location")).toBe(
      `http://localhost:3732/oauth/authorize?request=${oidcRequestId}`
    );
    expect(response.headers.get("set-cookie")).toContain("prism_session=");
  });

  it("resumes delegated consent after mock OAuth and persists configured chat:write scope", async () => {
    enableDelegatedDelivery();
    process.env.SLACK_USER_SCOPES = "search:read,chat:write";
    const delegatedRequestId = "ddr_12345678-1234-4123-8123-123456789012";
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("update slack_oauth_states")) {
        return {
          rows: [{
            redirect_uri: "http://localhost:3732/v1/slack/oauth/callback",
            oidc_authorization_request_id: null,
            delegated_delivery_request_id: delegatedRequestId
          }],
          rowCount: 1
        };
      }
      if (sql.includes("insert into prism_users")) return { rows: [{ id: "user_1" }], rowCount: 1 };
      if (sql.includes("insert into slack_connections")) return { rows: [{ id: "conn_1" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const { GET } = await import("./route");

    const response = await GET(new NextRequest(
      "http://localhost:3732/v1/slack/oauth/callback?code=mock-code&state=state-123",
      { headers: { cookie: "prism_slack_oauth_state=state-123" } }
    ));

    expect(response.headers.get("location")).toMatch(
      /^http:\/\/localhost:3732\/delegations\/slack-message\/authorize\?request=[A-Za-z0-9_-]{43}$/
    );
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    const userCredentialCall = mockDb.query.mock.calls.find(([sql, params]) =>
      String(sql).includes("insert into slack_credentials") && (params as unknown[] | undefined)?.[2] === "user"
    );
    expect(userCredentialCall?.[1]?.[7]).toBe("search:read,chat:write");
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("oauth_resume_handle_hash"),
      expect.arrayContaining([delegatedRequestId])
    );
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("set state = 'approved'"))).toBe(false);
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
