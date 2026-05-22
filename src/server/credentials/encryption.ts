import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type CredentialEnvelope = {
  algorithm: "local-aes-256-gcm-v1";
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export type CredentialCipher = {
  encrypt: (plaintext: string, aad: string) => Promise<CredentialEnvelope>;
  decrypt: (envelope: CredentialEnvelope, aad: string) => Promise<string>;
};

export function createLocalAesGcmCredentialCipher({
  key,
  keyId
}: {
  key: string;
  keyId: string;
}): CredentialCipher {
  const rawKey = Buffer.from(key, "base64");

  if (rawKey.length !== 32) {
    throw new Error("credential-encryption-key-invalid");
  }

  if (!keyId || keyId.includes("replace-with")) {
    throw new Error("credential-encryption-key-id-invalid");
  }

  return {
    async encrypt(plaintext: string, aad: string): Promise<CredentialEnvelope> {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", rawKey, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();

      return {
        algorithm: "local-aes-256-gcm-v1",
        keyId,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ciphertext: ciphertext.toString("base64")
      };
    },
    async decrypt(envelope: CredentialEnvelope, aad: string): Promise<string> {
      try {
        if (envelope.algorithm !== "local-aes-256-gcm-v1") {
          throw new Error("unsupported-algorithm");
        }

        const decipher = createDecipheriv("aes-256-gcm", rawKey, Buffer.from(envelope.iv, "base64"));
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64")),
          decipher.final()
        ]).toString("utf8");
      } catch {
        throw new Error("credential-decryption-failed");
      }
    }
  };
}
