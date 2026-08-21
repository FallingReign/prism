import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

describe("GET /.well-known/jwks.json", () => {
  beforeEach(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.NODE_ENV = "test";
    process.env.PRISM_PUBLIC_BASE_URL = "http://localhost:3732";
    process.env.PRISM_OIDC_ALLOW_INSECURE_HTTP = "1";
    process.env.PRISM_OIDC_PLAYTEST_CLIENT_ID = "shg-playtest";
    process.env.PRISM_OIDC_PLAYTEST_REDIRECT_URI = "http://localhost:3847/api/auth/callback";
    process.env.PRISM_OIDC_SIGNING_PRIVATE_KEY_BASE64 = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    process.env.PRISM_OIDC_SIGNING_KEY_ID = "test-rs256-v1";
  });

  it("returns one public RS256 JWK and no private key material", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig", kid: "test-rs256-v1" });
    expect(body.keys[0]).not.toHaveProperty("d");
    expect(body.keys[0]).not.toHaveProperty("p");
    expect(body.keys[0]).not.toHaveProperty("q");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
  });
});
