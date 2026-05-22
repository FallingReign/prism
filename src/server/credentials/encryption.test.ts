import { describe, expect, it } from "vitest";

import { createLocalAesGcmCredentialCipher } from "./encryption";

const key = Buffer.alloc(32, 7).toString("base64");

describe("Slack credential encryption", () => {
  it("round-trips credentials without storing plaintext in the envelope", async () => {
    const cipher = createLocalAesGcmCredentialCipher({ key, keyId: "test-key" });
    const plaintext = "xoxb-test-token-canary";
    const aad = "connection:conn_123:bot";

    const envelope = await cipher.encrypt(plaintext, aad);
    const serialized = JSON.stringify(envelope);

    expect(envelope.algorithm).toBe("local-aes-256-gcm-v1");
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain("xoxb-test-token-canary");
    await expect(cipher.decrypt(envelope, aad)).resolves.toBe(plaintext);
  });

  it("rejects decrypting a credential envelope with the wrong associated data", async () => {
    const cipher = createLocalAesGcmCredentialCipher({ key, keyId: "test-key" });
    const envelope = await cipher.encrypt("refresh-secret-canary", "connection:conn_123:user");

    await expect(cipher.decrypt(envelope, "connection:conn_999:user")).rejects.toThrow("credential-decryption-failed");
  });
});
