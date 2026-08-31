import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { refreshProofMessage, rotateRunnerCredentials, type CredentialRefreshStore } from "./credential-refresh";
import { hashSecret } from "./pairing-service";

const now = new Date("2026-08-31T08:00:00.000Z");

describe("remote Codex credential refresh", () => {
  it("rotates both credentials only with the current refresh token and registered device key", async () => {
    const signing = generateKeyPairSync("ed25519");
    const refreshToken = "rc_refresh_current-token-value";
    const store = refreshStore(signing, refreshToken);
    const proof = sign(null, refreshProofMessage("rc_install_1", refreshToken), signing.privateKey).toString("base64url");

    const result = await rotateRunnerCredentials({
      store,
      installationId: "rc_install_1",
      refreshToken,
      proof,
      now,
      randomBytes: (size) => Buffer.alloc(size, 9)
    });

    expect(result).toMatchObject({ kind: "rotated", accessToken: expect.stringMatching(/^rc_access_/), refreshToken: expect.stringMatching(/^rc_refresh_/) });
    expect(store.rotate).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "rc_install_1",
        presentedRefreshTokenHash: hashSecret(refreshToken),
        nextAccessTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        nextRefreshTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    );
    expect(JSON.stringify(store.rotate.mock.calls)).not.toContain(refreshToken);
    if (result.kind === "rotated") {
      expect(JSON.stringify(store.rotate.mock.calls)).not.toContain(result.accessToken);
      expect(JSON.stringify(store.rotate.mock.calls)).not.toContain(result.refreshToken);
    }
  });

  it("rejects wrong key proof before rotation and treats reuse as invalid", async () => {
    const signing = generateKeyPairSync("ed25519");
    const wrong = generateKeyPairSync("ed25519");
    const refreshToken = "rc_refresh_current-token-value";
    const store = refreshStore(signing, refreshToken);
    const wrongProof = sign(null, refreshProofMessage("rc_install_1", refreshToken), wrong.privateKey).toString("base64url");

    await expect(rotateRunnerCredentials({ store, installationId: "rc_install_1", refreshToken, proof: wrongProof, now })).resolves.toEqual({ kind: "invalid" });
    expect(store.rotate).not.toHaveBeenCalled();

    const proof = sign(null, refreshProofMessage("rc_install_1", refreshToken), signing.privateKey).toString("base64url");
    store.rotate.mockResolvedValue("reused");
    await expect(rotateRunnerCredentials({ store, installationId: "rc_install_1", refreshToken, proof, now })).resolves.toEqual({ kind: "invalid" });
  });
});

function refreshStore(
  signing: ReturnType<typeof generateKeyPairSync>,
  refreshToken: string
): CredentialRefreshStore & { read: ReturnType<typeof vi.fn>; rotate: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn(async () => ({
      installationId: "rc_install_1",
      signingPublicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
      refreshTokenHash: hashSecret(refreshToken),
      refreshTokenExpiresAt: new Date("2026-09-30T08:00:00.000Z")
    })),
    rotate: vi.fn(async () => "rotated" as const)
  };
}
