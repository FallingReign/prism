import "server-only";

import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

import { exportJWK, SignJWT, type JWK, type JWTPayload } from "jose";

import type { OidcProviderConfig } from "../config";

export type OidcSigningService = {
  keyId: string;
  publicJwk: JWK;
  sign: (payload: JWTPayload) => Promise<string>;
};

export async function createOidcSigningService(config: OidcProviderConfig): Promise<OidcSigningService> {
  let privateKey: KeyObject;
  try {
    const pem = Buffer.from(config.signing.privateKeyBase64, "base64").toString("utf8");
    privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    if (
      privateKey.asymmetricKeyType !== "rsa" ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error("unexpected-signing-key");
    }
    const publicKey = createPublicKey(privateKey);
    const exportedJwk = await exportJWK(publicKey);
    if (exportedJwk.kty !== "RSA" || !exportedJwk.n || !exportedJwk.e) throw new Error("unexpected-public-key");
    const publicJwk: JWK = { kty: "RSA", n: exportedJwk.n, e: exportedJwk.e };

    return {
      keyId: config.signing.keyId,
      publicJwk: { ...publicJwk, alg: "RS256", use: "sig", kid: config.signing.keyId },
      sign: (payload) =>
        new SignJWT(payload)
          .setProtectedHeader({ alg: "RS256", kid: config.signing.keyId, typ: "JWT" })
          .sign(privateKey)
    };
  } catch {
    throw new Error("oidc-signing-key-invalid");
  }
}
