import "server-only";

import { createPublicKey, randomBytes as nodeRandomBytes, verify } from "node:crypto";

import { hashSecret } from "./pairing-service";

export type CredentialRefreshRecord = {
  installationId: string;
  signingPublicKey: string;
  refreshTokenHash: string;
  refreshTokenExpiresAt: Date;
};

export type CredentialRefreshStore = {
  read(input: { installationId: string; now: Date }): Promise<CredentialRefreshRecord | null>;
  rotate(input: {
    installationId: string;
    presentedRefreshTokenHash: string;
    nextAccessTokenHash: string;
    nextAccessTokenExpiresAt: Date;
    nextRefreshTokenHash: string;
    nextRefreshTokenExpiresAt: Date;
    now: Date;
  }): Promise<"rotated" | "reused" | "invalid">;
};

export async function rotateRunnerCredentials({
  store,
  installationId,
  refreshToken,
  proof,
  now = new Date(),
  randomBytes = nodeRandomBytes
}: {
  store: CredentialRefreshStore;
  installationId: string;
  refreshToken: string;
  proof: string;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<
  | { kind: "rotated"; accessToken: string; refreshToken: string; accessTokenExpiresAt: string }
  | { kind: "invalid" }
> {
  if (
    !/^rc_install_[A-Za-z0-9_-]{1,100}$/.test(installationId) ||
    !/^rc_refresh_[A-Za-z0-9_-]{16,100}$/.test(refreshToken) ||
    !/^[A-Za-z0-9_-]{80,100}$/.test(proof)
  ) {
    return { kind: "invalid" };
  }
  const record = await store.read({ installationId, now });
  if (!record || record.refreshTokenExpiresAt.getTime() <= now.getTime()) return { kind: "invalid" };
  try {
    if (!verify(null, refreshProofMessage(installationId, refreshToken), createPublicKey(record.signingPublicKey), Buffer.from(proof, "base64url"))) {
      return { kind: "invalid" };
    }
  } catch {
    return { kind: "invalid" };
  }

  const accessToken = `rc_access_${randomBytes(32).toString("base64url")}`;
  const nextRefreshToken = `rc_refresh_${randomBytes(32).toString("base64url")}`;
  const accessTokenExpiresAt = new Date(now.getTime() + 15 * 60 * 1000);
  const rotated = await store.rotate({
    installationId,
    presentedRefreshTokenHash: hashSecret(refreshToken),
    nextAccessTokenHash: hashSecret(accessToken),
    nextAccessTokenExpiresAt: accessTokenExpiresAt,
    nextRefreshTokenHash: hashSecret(nextRefreshToken),
    nextRefreshTokenExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    now
  });
  if (rotated !== "rotated") return { kind: "invalid" };
  return {
    kind: "rotated",
    accessToken,
    refreshToken: nextRefreshToken,
    accessTokenExpiresAt: accessTokenExpiresAt.toISOString()
  };
}

export function refreshProofMessage(installationId: string, refreshToken: string): Buffer {
  return Buffer.from(`prism-remote-codex-refresh-v1\n${installationId}\n${hashSecret(refreshToken)}`, "utf8");
}
