import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { runnerProofMessage, verifyRunnerRequest, type RunnerAuthStore } from "./runner-auth";

const now = new Date("2026-08-31T07:00:00.000Z");

describe("remote Codex runner authentication", () => {
  it("requires the short-lived bearer token, registered signing key, body hash, and a fresh nonce", async () => {
    const signing = generateKeyPairSync("ed25519");
    const store = authStore(signing.publicKey.export({ format: "pem", type: "spki" }).toString());
    const body = JSON.stringify({ catalogVersion: "catalog_1", sessions: [] });
    const input = signedRequest(signing, body);

    await expect(verifyRunnerRequest({ store, ...input, now })).resolves.toEqual({
      kind: "authenticated",
      installationId: "rc_install_1",
      prismUserId: "owner_1",
      slackConnectionId: "connection-owner"
    });
    expect(store.resolveAccess).toHaveBeenCalledWith({
      installationId: "rc_install_1",
      accessTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      now
    });
    expect(store.claimNonce).toHaveBeenCalledWith({
      installationId: "rc_install_1",
      nonce: "nonce_1234567890abcdef",
      requestTimestamp: now,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      now
    });
  });

  it("rejects body tampering, stale clocks, signature mismatch, and replay", async () => {
    const signing = generateKeyPairSync("ed25519");
    const wrong = generateKeyPairSync("ed25519");
    const publicKey = signing.publicKey.export({ format: "pem", type: "spki" }).toString();

    await expect(verifyRunnerRequest({ store: authStore(publicKey), ...signedRequest(signing, "original"), body: "tampered", now })).resolves.toEqual({
      kind: "invalid"
    });
    await expect(
      verifyRunnerRequest({ store: authStore(publicKey), ...signedRequest(signing, "body", new Date(now.getTime() - 6 * 60 * 1000)), now })
    ).resolves.toEqual({ kind: "invalid" });
    await expect(verifyRunnerRequest({ store: authStore(publicKey), ...signedRequest(wrong, "body"), now })).resolves.toEqual({ kind: "invalid" });

    const replayStore = authStore(publicKey);
    replayStore.claimNonce.mockResolvedValue(false);
    await expect(verifyRunnerRequest({ store: replayStore, ...signedRequest(signing, "body"), now })).resolves.toEqual({ kind: "invalid" });
  });

  it("rejects revoked installations before accepting a nonce", async () => {
    const signing = generateKeyPairSync("ed25519");
    const store = authStore(signing.publicKey.export({ format: "pem", type: "spki" }).toString());
    store.resolveAccess.mockResolvedValue(null);

    await expect(verifyRunnerRequest({ store, ...signedRequest(signing, "body"), now })).resolves.toEqual({ kind: "invalid" });
    expect(store.claimNonce).not.toHaveBeenCalled();
  });
});

function authStore(signingPublicKey: string): RunnerAuthStore & {
  resolveAccess: ReturnType<typeof vi.fn>;
  claimNonce: ReturnType<typeof vi.fn>;
} {
  return {
    resolveAccess: vi.fn(async () => ({
      installationId: "rc_install_1",
      prismUserId: "owner_1",
      slackConnectionId: "connection-owner",
      signingPublicKey
    })),
    claimNonce: vi.fn(async () => true)
  };
}

function signedRequest(
  signing: ReturnType<typeof generateKeyPairSync>,
  body: string,
  timestamp = now
) {
  const input = {
    method: "POST",
    path: "/v1/prism/remote-codex/runner/sessions",
    body,
    installationId: "rc_install_1",
    accessToken: "rc_access_copy-once-12345678",
    timestamp: timestamp.toISOString(),
    nonce: "nonce_1234567890abcdef"
  };
  return {
    ...input,
    signature: sign(null, runnerProofMessage(input), signing.privateKey).toString("base64url")
  };
}
