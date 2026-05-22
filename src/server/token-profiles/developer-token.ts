import "server-only";

import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

export type DeveloperTokenConfig = {
  pepper: string;
  pepperId: string;
};

export type DeveloperTokenVerifier = {
  tokenHash: string;
  algorithm: "hmac-sha256";
  pepperId: string;
};

export function issueDeveloperToken({
  randomBytes = nodeRandomBytes
}: {
  randomBytes?: (size: number) => Buffer;
} = {}): string {
  return `prism_dev_${randomBytes(32).toString("base64url")}`;
}

export function hashDeveloperToken(token: string, config: DeveloperTokenConfig): DeveloperTokenVerifier {
  return {
    tokenHash: createHmac("sha256", config.pepper).update(token).digest("hex"),
    algorithm: "hmac-sha256",
    pepperId: config.pepperId
  };
}

export function verifyDeveloperToken(token: string, verifier: DeveloperTokenVerifier, config: DeveloperTokenConfig): boolean {
  if (verifier.algorithm !== "hmac-sha256" || verifier.pepperId !== config.pepperId) return false;
  const candidate = hashDeveloperToken(token, config).tokenHash;
  const candidateBuffer = Buffer.from(candidate, "hex");
  const verifierBuffer = Buffer.from(verifier.tokenHash, "hex");
  return candidateBuffer.length === verifierBuffer.length && timingSafeEqual(candidateBuffer, verifierBuffer);
}
