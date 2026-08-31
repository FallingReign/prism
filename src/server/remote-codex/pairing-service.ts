import "server-only";

import {
  createHash,
  createPublicKey,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
  verify
} from "node:crypto";

export type PairingStatus = "pending" | "approved" | "consumed" | "expired";

export type PairingRecord = {
  id: string;
  secretHash: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  machineLabel: string;
  companionVersion: string;
  verificationPhrase: string;
  sourceKey: string;
  sourceAttributed: boolean;
  signingKeyFingerprint: string;
  status: PairingStatus;
  expiresAt: Date;
  approvedPrismUserId: string | null;
  approvedSlackConnectionId: string | null;
  approvedTeamId: string | null;
};

export type PairingStore = {
  savePairing(record: PairingRecord): Promise<void>;
  getPairing(input: { pairingId: string; now: Date }): Promise<PairingRecord | null>;
  approvePairing(input: {
    pairingId: string;
    sessionTokenHash: string;
    targetTeamId: string;
    now: Date;
  }): Promise<
    | { kind: "approved"; machineLabel: string; slackConnectionId: string }
    | { kind: "unauthenticated" | "wrong_owner" | "invalid" }
  >;
  recordFailedExchange(input: { pairingId: string; now: Date }): Promise<void>;
  completeExchange(input: {
    pairingId: string;
    secretHash: string;
    accessTokenHash: string;
    accessTokenExpiresAt: Date;
    refreshTokenHash: string;
    refreshTokenExpiresAt: Date;
    now: Date;
  }): Promise<{ installationId: string } | null>;
};

export async function createPairing({
  store,
  publicBaseUrl,
  signingPublicKey,
  encryptionPublicKey,
  sourceIdentifier,
  sourceKey,
  machineLabel,
  companionVersion,
  now = new Date(),
  randomBytes = nodeRandomBytes
}: {
  store: PairingStore;
  publicBaseUrl: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  machineLabel: string;
  companionVersion: string;
  sourceIdentifier: string;
  sourceKey: string;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<{
  pairingId: string;
  oneTimeSecret: string;
  approvalUrl: string;
  verificationPhrase: string;
  expiresAt: string;
}> {
  const normalizedMachineLabel = validateMachineLabel(machineLabel);
  const normalizedVersion = validateVersion(companionVersion);
  const signing = canonicalPublicKey(signingPublicKey, "ed25519", "invalid-signing-key");
  const encryption = canonicalEncryptionPublicKey(encryptionPublicKey);

  const pairingId = `rc_pair_${randomBytes(16).toString("base64url")}`;
  const oneTimeSecret = `rc_pair_secret_${randomBytes(32).toString("base64url")}`;
  const verificationPhrase = createVerificationPhrase(randomBytes(3));
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  await store.savePairing({
    id: pairingId,
    secretHash: hashSecret(oneTimeSecret),
    signingPublicKey: signing.pem,
    encryptionPublicKey: encryption,
    machineLabel: normalizedMachineLabel,
    companionVersion: normalizedVersion,
    verificationPhrase,
    sourceKey,
    sourceAttributed: sourceIdentifier !== "unattributed",
    signingKeyFingerprint: signing.fingerprint,
    status: "pending",
    expiresAt,
    approvedPrismUserId: null,
    approvedSlackConnectionId: null,
    approvedTeamId: null
  });

  const base = publicBaseUrl.replace(/\/$/, "");
  return {
    pairingId,
    oneTimeSecret,
    approvalUrl: `${base}/remote-codex/pair/${encodeURIComponent(pairingId)}`,
    verificationPhrase,
    expiresAt: expiresAt.toISOString()
  };
}

export async function approvePairing({
  store,
  pairingId,
  sessionToken,
  targetTeamId,
  now = new Date()
}: {
  store: PairingStore;
  pairingId: string;
  sessionToken: string | undefined;
  targetTeamId: string;
  now?: Date;
}): Promise<
  | { kind: "approved"; machineLabel: string; slackConnectionId: string }
  | { kind: "unauthenticated" | "wrong_owner" | "invalid" }
> {
  if (!sessionToken) return { kind: "unauthenticated" };
  if (!validOpaqueId(pairingId, "rc_pair_") || !/^T[A-Z0-9]{2,31}$/.test(targetTeamId)) return { kind: "invalid" };
  return store.approvePairing({
    pairingId,
    sessionTokenHash: hashSecret(sessionToken),
    targetTeamId,
    now
  });
}

export async function exchangePairing({
  store,
  pairingId,
  oneTimeSecret,
  proof,
  now = new Date(),
  randomBytes = nodeRandomBytes
}: {
  store: PairingStore;
  pairingId: string;
  oneTimeSecret: string;
  proof: string;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<
  | { kind: "connected"; installationId: string; accessToken: string; refreshToken: string; accessTokenExpiresAt: string }
  | { kind: "pending" | "invalid" }
> {
  if (!validOpaqueId(pairingId, "rc_pair_") || !oneTimeSecret.startsWith("rc_pair_secret_")) return { kind: "invalid" };
  const record = await store.getPairing({ pairingId, now });
  if (!record) return { kind: "invalid" };
  if (record.status === "pending") return { kind: "pending" };
  if (
    record.status !== "approved" ||
    record.expiresAt.getTime() <= now.getTime() ||
    !record.approvedPrismUserId ||
    !record.approvedSlackConnectionId ||
    !record.approvedTeamId
  ) {
    return { kind: "invalid" };
  }

  const secretHash = hashSecret(oneTimeSecret);
  if (!safeHashEqual(record.secretHash, secretHash) || !validPairingProof(record.signingPublicKey, pairingId, oneTimeSecret, proof)) {
    await store.recordFailedExchange({ pairingId, now });
    return { kind: "invalid" };
  }

  const accessToken = `rc_access_${randomBytes(32).toString("base64url")}`;
  const refreshToken = `rc_refresh_${randomBytes(32).toString("base64url")}`;
  const accessTokenExpiresAt = new Date(now.getTime() + 15 * 60 * 1000);
  const refreshTokenExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const completed = await store.completeExchange({
    pairingId,
    secretHash,
    accessTokenHash: hashSecret(accessToken),
    accessTokenExpiresAt,
    refreshTokenHash: hashSecret(refreshToken),
    refreshTokenExpiresAt,
    now
  });
  if (!completed) return { kind: "invalid" };
  return {
    kind: "connected",
    installationId: completed.installationId,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: accessTokenExpiresAt.toISOString()
  };
}

export function pairingProofMessage(pairingId: string, oneTimeSecret: string): Buffer {
  return Buffer.from(`prism-remote-codex-pairing-v1\n${pairingId}\n${hashSecret(oneTimeSecret)}`, "utf8");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function validPairingProof(publicKey: string, pairingId: string, oneTimeSecret: string, proof: string): boolean {
  try {
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(proof)) return false;
    return verify(null, pairingProofMessage(pairingId, oneTimeSecret), createPublicKey(publicKey), Buffer.from(proof, "base64url"));
  } catch {
    return false;
  }
}

function canonicalPublicKey(
  pem: string,
  keyType: "ed25519" | "x25519",
  error: string
): { pem: string; fingerprint: string } {
  try {
    if (pem.length > 1_000) throw new Error(error);
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== keyType) throw new Error(error);
    const der = key.export({ format: "der", type: "spki" });
    return {
      pem: key.export({ format: "pem", type: "spki" }).toString(),
      fingerprint: createHash("sha256").update(der).digest("hex")
    };
  } catch {
    throw new Error(error);
  }
}

function canonicalEncryptionPublicKey(value: string): string {
  if (/^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, "base64url").length === 32) return value;
  return canonicalPublicKey(value, "x25519", "invalid-encryption-key").pem;
}

function validateMachineLabel(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 60 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("invalid-machine-label");
  return normalized;
}

function validateVersion(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(normalized)) throw new Error("invalid-companion-version");
  return normalized;
}

function validOpaqueId(value: string, prefix: string): boolean {
  return value.length <= 128 && value.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(value);
}

function safeHashEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

const phraseAdjectives = ["amber", "bright", "calm", "coral", "green", "silver", "violet", "warm"];
const phraseNouns = ["cedar", "cloud", "harbor", "meadow", "river", "sparrow", "star", "willow"];

function createVerificationPhrase(bytes: Buffer): string {
  const adjective = phraseAdjectives[bytes[0] % phraseAdjectives.length];
  const noun = phraseNouns[bytes[1] % phraseNouns.length];
  const number = 10 + (bytes[2] % 90);
  return `${adjective}-${noun}-${number}`;
}
