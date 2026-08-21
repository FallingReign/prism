import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { canonicalJson, sha256Hex } from "../../../../../../src/server/delegated-delivery/validation";

const mockDb = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("../../../../../../src/server/db", () => ({ database: mockDb }));

describe("POST /v1/prism/delegations/slack-message/requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDelegatedDeliveryEnv();
  });

  it("returns disabled before reading or persisting caller material", async () => {
    const { POST } = await import("./route");
    const response = await POST(request("SECRET_DISABLED_BODY_CANARY", { "content-type": "text/plain" }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: "feature_disabled", request_id: body.request_id });
    expect(body.request_id).toBe(response.headers.get("X-Prism-Request-ID"));
    expect(JSON.stringify(body)).not.toContain("SECRET_DISABLED_BODY_CANARY");
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expectSecure(response);
  });

  it.each([
    ["wrong media type", "http://localhost:3732/v1/prism/delegations/slack-message/requests", { "content-type": "text/plain", "prism-client-proof": "bad" }],
    ["query string", "http://localhost:3732/v1/prism/delegations/slack-message/requests?extra=1", { "content-type": "application/json", "prism-client-proof": "bad" }],
    ["authorization header", "http://localhost:3732/v1/prism/delegations/slack-message/requests", { "content-type": "application/json", authorization: "Bearer forbidden", "prism-client-proof": "bad" }],
    ["declared oversized body", "http://localhost:3732/v1/prism/delegations/slack-message/requests", { "content-type": "application/json", "content-length": String(512 * 1024 + 1), "prism-client-proof": "bad" }]
  ])("rejects %s before service persistence", async (_label, url, headers) => {
    enableDelegatedDelivery();
    const { POST } = await import("./route");
    const response = await POST(request("{}", headers, url));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expectSecure(response);
  });

  it("rejects missing and malformed client proof without persistence", async () => {
    enableDelegatedDelivery();
    const { POST } = await import("./route");
    const missing = await POST(request("{}", { "content-type": "application/json" }));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({ error: "invalid_client_proof" });

    const malformed = await POST(request(validBody(), {
      "content-type": "application/json",
      "prism-client-proof": "not-a-compact-jws"
    }));
    expect(malformed.status).toBe(401);
    await expect(malformed.json()).resolves.toMatchObject({ error: "invalid_client_proof" });
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("stops an undeclared oversized JSON stream before parsing or persistence", async () => {
    enableDelegatedDelivery();
    const { POST } = await import("./route");
    const response = await POST(request("x".repeat(512 * 1024 + 1), {
      "content-type": "application/json",
      "prism-client-proof": "not-a-compact-jws"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("uses proxy source headers only in strict trusted-ingress mode", async () => {
    enableDelegatedDelivery();
    const { POST } = await import("./route");
    const ignoredSpoof = await POST(request(validBody(), {
      "content-type": "application/json",
      "prism-client-proof": "not-a-compact-jws",
      "x-forwarded-for": "attacker-selected"
    }));
    expect(ignoredSpoof.status).toBe(401);

    process.env.PRISM_DELEGATED_SLACK_DELIVERY_TRUST_PROXY_HEADERS = "1";
    const acceptedSource = await POST(request(validBody(), {
      "content-type": "application/json",
      "prism-client-proof": "not-a-compact-jws",
      "x-forwarded-for": "2001:DB8::1"
    }));
    expect(acceptedSource.status).toBe(401);

    for (const headers of [
      {},
      { "x-forwarded-for": "192.0.2.1, 10.0.0.1" },
      { "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.2" }
    ]) {
      const rejected = await POST(request("SOURCE_BODY_CANARY", {
        "content-type": "application/json",
        "prism-client-proof": "not-a-compact-jws",
        ...headers
      }));
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toMatchObject({ error: "invalid_request" });
      expectSecure(rejected);
    }
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("rejects unknown JSON fields before proof verification or persistence", async () => {
    enableDelegatedDelivery();
    const parsed = JSON.parse(validBody()) as Record<string, unknown>;
    parsed.untrusted_sender = "UATTACKER";
    const { POST } = await import("./route");
    const response = await POST(request(JSON.stringify(parsed), {
      "content-type": "application/json",
      "prism-client-proof": "not-a-compact-jws"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

function request(body: string, headers: Record<string, string>, url = "http://localhost:3732/v1/prism/delegations/slack-message/requests"): NextRequest {
  return new NextRequest(url, { method: "POST", headers, body });
}

function validBody(): string {
  const payload = { channel: "C123ABC", text: "Exact preview", blocks: [] };
  const now = Date.now();
  return JSON.stringify({
    client_id: "shg-playtest-delegation",
    callback_uri: "http://localhost:3847/api/announcements/delegation/callback",
    external_job_id: "job-123",
    revision: 1,
    idempotency_key: "job-123:1",
    expected_subject: "prism-user-123",
    team_id: "T123ABC",
    channel_id: "C123ABC",
    action: "chat.postMessage",
    execution_mode: "user",
    payload,
    payload_sha256: sha256Hex(canonicalJson(payload)),
    not_before: new Date(now + 5 * 60_000).toISOString(),
    delivery_expires_at: new Date(now + 20 * 60_000).toISOString(),
    state: "s".repeat(43),
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    dpop_jkt: "j".repeat(43)
  });
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
    PRISM_DELEGATED_SLACK_DELIVERY_GRANT_PEPPER_ID: "delegated-grants-v1",
    PRISM_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    PRISM_CREDENTIAL_ENCRYPTION_KEY_ID: "delegation-route-test-key"
  });
}
