import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));

vi.mock("../../../../../../src/server/db", () => ({ database: mockDb }));

describe("delegated delivery browser mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableDelegatedDelivery();
  });

  it.each([
    ["approve", () => import("./[id]/approve/route")],
    ["deny", () => import("./[id]/deny/route")]
  ])("rejects cross-origin %s as a distinct hardened verification error before DB access", async (_name, loadRoute) => {
    const { POST } = await loadRoute();
    const response = await POST(new NextRequest(
      `http://localhost:3732/v1/prism/delegations/slack-message/ddr_12345678-1234-4123-8123-123456789012/${_name}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://attacker.example",
          "sec-fetch-site": "cross-site"
        },
        body: ""
      }
    ), { params: { id: "ddr_12345678-1234-4123-8123-123456789012" } });
    const html = await response.text();

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(html).toContain("Approval request could not be verified");
    expect(html).toContain("Return to the original Prism approval page and try again.");
    expect(html).not.toContain("Approval is not available for this identity");
    expect(html).not.toContain("attacker.example");
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("rejects non-empty approve form fields as generic HTML", async () => {
    const { POST } = await import("./[id]/approve/route");
    const response = await POST(new NextRequest(
      "http://localhost:3732/v1/prism/delegations/slack-message/ddr_12345678-1234-4123-8123-123456789012/approve",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost:3732",
          "sec-fetch-site": "same-origin"
        },
        body: "sender=UATTACKER"
      }
    ), { params: { id: "ddr_12345678-1234-4123-8123-123456789012" } });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).not.toContain("UATTACKER");
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

function enableDelegatedDelivery(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PRISM_DELEGATED_SLACK_DELIVERY_")) delete process.env[key];
  }
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
