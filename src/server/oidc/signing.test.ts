import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";

import { createOidcSigningService } from "./signing";

function testConfig() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    issuer: "https://prism.example",
    playtestClient: {
      clientId: "shg-playtest",
      redirectUri: "https://playtest.example/api/auth/callback",
      tokenEndpointAuthMethod: "none" as const
    },
    signing: { privateKeyBase64: Buffer.from(pem).toString("base64"), keyId: "test-rs256-v1" },
    allowInsecureHttp: false,
    abuseProtection: {
      authorizeWindowMs: 60_000, maxAuthorizeRequestsPerSource: 30,
      maxAuthorizeRequestsPerClient: 300, maxOutstandingPendingPerSource: 10,
      maxOutstandingPendingPerClient: 500, cleanupBatchSize: 100, trustProxyHeaders: false
    }
  };
}

describe("OIDC signing", () => {
  it("signs RS256 tokens with the configured kid and exposes only the public JWK", async () => {
    const config = testConfig();
    const service = await createOidcSigningService(config);
    const token = await service.sign({ sub: "user-1", aud: config.playtestClient.clientId, nonce: "nonce-1" });
    const header = decodeProtectedHeader(token);
    const payload = decodeJwt(token);
    const jwk = service.publicJwk;

    expect(header).toMatchObject({ alg: "RS256", kid: "test-rs256-v1", typ: "JWT" });
    expect(payload).toMatchObject({ sub: "user-1", aud: "shg-playtest", nonce: "nonce-1" });
    expect(jwk).toMatchObject({ kty: "RSA", alg: "RS256", kid: "test-rs256-v1", use: "sig" });
    expect(jwk).not.toHaveProperty("d");
    await expect(jwtVerify(token, await importJWK(jwk, "RS256"))).resolves.toMatchObject({ payload: { sub: "user-1" } });
  });

  it("rejects malformed or non-RSA signing keys without echoing their value", async () => {
    const secret = Buffer.from("not-a-private-key-secret-canary").toString("base64");
    await expect(
      createOidcSigningService({
        ...testConfig(),
        signing: { privateKeyBase64: secret, keyId: "kid" }
      })
    ).rejects.toThrow("oidc-signing-key-invalid");
    await expect(
      createOidcSigningService({
        ...testConfig(),
        signing: { privateKeyBase64: "replace-with-private-key", keyId: "kid" }
      })
    ).rejects.toThrow("oidc-signing-key-invalid");
  });

  it("accepts stronger RSA keys while retaining an explicitly public RS256 JWK", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const service = await createOidcSigningService({
      ...testConfig(),
      signing: {
        privateKeyBase64: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64"),
        keyId: "test-rs256-3072"
      }
    });

    expect(service.publicJwk).toEqual(expect.objectContaining({ kty: "RSA", alg: "RS256", use: "sig", kid: "test-rs256-3072" }));
    expect(service.publicJwk).not.toHaveProperty("d");
    expect(service.publicJwk).not.toHaveProperty("p");
    expect(service.publicJwk).not.toHaveProperty("q");
  });
});
