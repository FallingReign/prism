import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("../../../../../../src/server/db", () => ({ database: mockDb }));

describe("POST /v1/prism/delegations/slack-message/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDelegatedDeliveryEnv();
  });

  it("returns disabled before parsing or persistence", async () => {
    const { POST } = await import("./route");
    const response = await POST(request("GRANT_SECRET_CANARY", { "content-type": "text/plain" }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("feature_disabled");
    expect(body.request_id).toBe(response.headers.get("X-Prism-Request-ID"));
    expect(JSON.stringify(body)).not.toContain("GRANT_SECRET_CANARY");
    expect(mockDb.query).not.toHaveBeenCalled();
    expectSecure(response);
  });

  it.each([
    ["wrong media type", "http://localhost:3732/v1/prism/delegations/slack-message/token", { "content-type": "application/json", dpop: "bad" }],
    ["query string", "http://localhost:3732/v1/prism/delegations/slack-message/token?extra=1", { "content-type": "application/x-www-form-urlencoded", dpop: "bad" }],
    ["authorization header", "http://localhost:3732/v1/prism/delegations/slack-message/token", { "content-type": "application/x-www-form-urlencoded", authorization: "Bearer forbidden", dpop: "bad" }],
    ["client-proof header", "http://localhost:3732/v1/prism/delegations/slack-message/token", { "content-type": "application/x-www-form-urlencoded", "prism-client-proof": "forbidden", dpop: "bad" }],
    ["declared oversized body", "http://localhost:3732/v1/prism/delegations/slack-message/token", { "content-type": "application/x-www-form-urlencoded", "content-length": String(16 * 1024 + 1), dpop: "bad" }]
  ])("rejects %s before store access", async (_label, url, headers) => {
    enableDelegatedDelivery();
    const { POST } = await import("./route");
    const response = await POST(request("grant_type=x", headers, url));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(mockDb.query).not.toHaveBeenCalled();
    expectSecure(response);
  });

  it("rejects missing DPoP before reading a token form", async () => {
    enableDelegatedDelivery();
    const { POST } = await import("./route");
    const response = await POST(request("", { "content-type": "application/x-www-form-urlencoded" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("stops an undeclared oversized form stream before parsing or store access", async () => {
    enableDelegatedDelivery();
    const { POST } = await import("./route");
    const response = await POST(request("x".repeat(16 * 1024 + 1), {
      "content-type": "application/x-www-form-urlencoded",
      dpop: "not-a-compact-jws"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects unknown form fields before proof or store work", async () => {
    enableDelegatedDelivery();
    const { POST } = await import("./route");
    const response = await POST(request(`${validForm()}&sender=UATTACKER`, {
      "content-type": "application/x-www-form-urlencoded",
      dpop: "not-a-compact-jws"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects malformed DPoP after a hash-only code binding lookup", async () => {
    enableDelegatedDelivery();
    mockDb.query.mockResolvedValue({
      rows: [{
        dpop_jkt: "j".repeat(43),
        used_at: null,
        code_expires_at: new Date(Date.now() + 60_000),
        request_state: "approved",
        delivery_expires_at: new Date(Date.now() + 10 * 60_000)
      }],
      rowCount: 1
    });
    const { POST } = await import("./route");
    const response = await POST(request(validForm(), {
      "content-type": "application/x-www-form-urlencoded",
      dpop: "not-a-compact-jws"
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

function validForm(): string {
  return new URLSearchParams({
    grant_type: "urn:prism:params:grant-type:delegated-slack-message",
    client_id: "shg-playtest-delegation",
    redirect_uri: "http://localhost:3847/api/announcements/delegation/callback",
    code: "c".repeat(43),
    code_verifier: "v".repeat(43)
  }).toString();
}

function request(body: string, headers: Record<string, string>, url = "http://localhost:3732/v1/prism/delegations/slack-message/token"): NextRequest {
  return new NextRequest(url, { method: "POST", headers, body });
}

function expectSecure(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
}

function clearDelegatedDeliveryEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PRISM_DELEGATED_SLACK_DELIVERY_")) delete process.env[key];
  }
}

function enableDelegatedDelivery(): void {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" });
  Object.assign(process.env, {
    NODE_ENV: "test",
    PRISM_PUBLIC_BASE_URL: "http://localhost:3732",
    PRISM_DELEGATED_SLACK_DELIVERY_ENABLED: "1",
    PRISM_DELEGATED_SLACK_DELIVERY_ALLOW_INSECURE_HTTP: "1",
    PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_ID: "shg-playtest-delegation",
    PRISM_DELEGATED_SLACK_DELIVERY_CALLBACK_URI: "http://localhost:3847/api/announcements/delegation/callback",
    PRISM_DELEGATED_SLACK_DELIVERY_CLIENT_JWKS: JSON.stringify({ keys: [{
      kty: "EC", crv: "P-256", alg: "ES256", kid: "playtest-es256-v1",
      x: publicJwk.x, y: publicJwk.y, use: "sig", key_ops: ["verify"]
    }] }),
    PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER: "delegated-grant-pepper-secret-canary-32-bytes",
    PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID: "delegated-grants-v1"
  });
}
