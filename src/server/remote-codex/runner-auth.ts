import "server-only";

import { createHash, createPublicKey, verify } from "node:crypto";

import { hashSecret } from "./pairing-service";

export type RunnerAccessIdentity = {
  installationId: string;
  prismUserId: string;
  slackConnectionId: string;
  signingPublicKey: string;
};

export type RunnerAuthStore = {
  resolveAccess(input: { installationId: string; accessTokenHash: string; now: Date }): Promise<RunnerAccessIdentity | null>;
  claimNonce(input: {
    installationId: string;
    nonce: string;
    requestTimestamp: Date;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean>;
};

type RunnerProofInput = {
  method: string;
  path: string;
  body: string;
  installationId: string;
  accessToken: string;
  timestamp: string;
  nonce: string;
};

export async function verifyRunnerRequest({
  store,
  signature,
  now = new Date(),
  ...proofInput
}: RunnerProofInput & { store: RunnerAuthStore; signature: string; now?: Date }): Promise<
  | { kind: "authenticated"; installationId: string; prismUserId: string; slackConnectionId: string }
  | { kind: "invalid" }
> {
  const requestTimestamp = parseTimestamp(proofInput.timestamp);
  if (
    !requestTimestamp ||
    Math.abs(now.getTime() - requestTimestamp.getTime()) > 5 * 60 * 1000 ||
    !/^rc_install_[A-Za-z0-9_-]{1,100}$/.test(proofInput.installationId) ||
    !/^rc_access_[A-Za-z0-9_-]{16,100}$/.test(proofInput.accessToken) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(proofInput.nonce) ||
    !/^[A-Za-z0-9_-]{80,100}$/.test(signature) ||
    !/^\/v1\/prism\/remote-codex\/runner\/[A-Za-z0-9_/-]+$/.test(proofInput.path) ||
    !/^(GET|POST|DELETE)$/.test(proofInput.method)
  ) {
    return { kind: "invalid" };
  }

  const access = await store.resolveAccess({
    installationId: proofInput.installationId,
    accessTokenHash: hashSecret(proofInput.accessToken),
    now
  });
  if (!access || !validSignature(access.signingPublicKey, proofInput, signature)) return { kind: "invalid" };

  const claimed = await store.claimNonce({
    installationId: access.installationId,
    nonce: proofInput.nonce,
    requestTimestamp,
    expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    now
  });
  if (!claimed) return { kind: "invalid" };
  return {
    kind: "authenticated",
    installationId: access.installationId,
    prismUserId: access.prismUserId,
    slackConnectionId: access.slackConnectionId
  };
}

export function runnerProofMessage(input: RunnerProofInput): Buffer {
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  return Buffer.from(
    `prism-remote-codex-runner-v1\n${input.installationId}\n${input.method}\n${input.path}\n${input.timestamp}\n${input.nonce}\n${bodyHash}`,
    "utf8"
  );
}

function validSignature(publicKey: string, input: RunnerProofInput, signature: string): boolean {
  try {
    return verify(null, runnerProofMessage(input), createPublicKey(publicKey), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function parseTimestamp(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed : null;
}
