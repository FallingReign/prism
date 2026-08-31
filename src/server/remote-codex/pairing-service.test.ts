import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  approvePairing,
  createPairing,
  exchangePairing,
  pairingProofMessage,
  type PairingRecord,
  type PairingStore
} from "./pairing-service";

const now = new Date("2026-08-31T04:00:00.000Z");

describe("remote Codex pairing", () => {
  it("creates a short-lived browser approval without putting the secret in its URL", async () => {
    const { signingPublicKey, encryptionPublicKey } = devicePublicKeys();
    const store = memoryStore();
    const created = await createPairing({
      store,
      publicBaseUrl: "https://prism.example.test/",
      ...pairingSource,
      signingPublicKey,
      encryptionPublicKey,
      machineLabel: "  Jill's Workstation  ",
      companionVersion: "0.1.0",
      now,
      randomBytes: deterministicRandom
    });

    expect(created.approvalUrl).toBe(`https://prism.example.test/remote-codex/pair/${created.pairingId}`);
    expect(created.approvalUrl).not.toContain(created.oneTimeSecret);
    expect(created.verificationPhrase).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    expect(store.record).toMatchObject({
      id: created.pairingId,
      machineLabel: "Jill's Workstation",
      companionVersion: "0.1.0",
      status: "pending"
    });
    expect(JSON.stringify(store.record)).not.toContain(created.oneTimeSecret);
  });

  it("uses one canonical signing-key fingerprint across equivalent PEM formatting", async () => {
    const signing = generateKeyPairSync("ed25519");
    const encryption = generateKeyPairSync("x25519");
    const signingPem = signing.publicKey.export({ format: "pem", type: "spki" }).toString();
    const encryptionPublicKey = encryption.publicKey.export({ format: "pem", type: "spki" }).toString();
    const store = memoryStore();

    await createPairing({
      store,
      publicBaseUrl: "https://prism.example.test",
      ...pairingSource,
      signingPublicKey: signingPem,
      encryptionPublicKey,
      machineLabel: "Workstation",
      companionVersion: "0.1.0",
      now,
      randomBytes: deterministicRandom
    });
    const first = store.record;
    await createPairing({
      store,
      publicBaseUrl: "https://prism.example.test",
      ...pairingSource,
      signingPublicKey: `\n${signingPem.replace(/\n/g, "\r\n")}\n`,
      encryptionPublicKey,
      machineLabel: "Workstation",
      companionVersion: "0.1.0",
      now,
      randomBytes: deterministicRandom
    });

    expect(store.record?.signingKeyFingerprint).toBe(first?.signingKeyFingerprint);
    expect(store.record?.signingPublicKey).toBe(first?.signingPublicKey);
  });

  it("binds approval to the exact browser session and explicit target workspace", async () => {
    const store = memoryStore();
    store.record = pairingRecord({ status: "pending", approvedPrismUserId: null, approvedSlackConnectionId: null });

    await expect(
      approvePairing({
        store,
        pairingId: "rc_pair_1",
        sessionToken: "session-owner",
        targetTeamId: "T123",
        now
      })
    ).resolves.toEqual({ kind: "approved", machineLabel: "Jill's Workstation", slackConnectionId: "connection-owner" });
    expect(store.approvePairing).toHaveBeenCalledWith({
      pairingId: "rc_pair_1",
      sessionTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetTeamId: "T123",
      now
    });

    await expect(
      approvePairing({ store, pairingId: "rc_pair_1", sessionToken: undefined, targetTeamId: "T123", now })
    ).resolves.toEqual({ kind: "unauthenticated" });
  });

  it("exchanges an approved one-time secret only with proof from the registered signing key", async () => {
    const signing = generateKeyPairSync("ed25519");
    const encryption = generateKeyPairSync("x25519");
    const oneTimeSecret = "rc_pair_secret_never-stored-plain";
    const store = memoryStore();
    store.record = pairingRecord({
      signingPublicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
      encryptionPublicKey: encryption.publicKey.export({ format: "pem", type: "spki" }).toString(),
      oneTimeSecret
    });
    const proof = sign(null, pairingProofMessage("rc_pair_1", oneTimeSecret), signing.privateKey).toString("base64url");

    const result = await exchangePairing({
      store,
      pairingId: "rc_pair_1",
      oneTimeSecret,
      proof,
      now,
      randomBytes: deterministicRandom
    });

    expect(result).toMatchObject({ kind: "connected", installationId: "installation_1" });
    if (result.kind !== "connected") throw new Error("expected connected result");
    expect(result.accessToken).not.toBe(result.refreshToken);
    expect(store.completeExchange).toHaveBeenCalledWith(
      expect.objectContaining({
        pairingId: "rc_pair_1",
        secretHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        accessTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        refreshTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    );
    expect(JSON.stringify(store.completeExchange.mock.calls)).not.toContain(oneTimeSecret);
    expect(JSON.stringify(store.completeExchange.mock.calls)).not.toContain(result.accessToken);
    expect(JSON.stringify(store.completeExchange.mock.calls)).not.toContain(result.refreshToken);
  });

  it("rejects wrong secrets, wrong keys, expired requests, and replayed exchanges", async () => {
    const signing = generateKeyPairSync("ed25519");
    const wrongSigning = generateKeyPairSync("ed25519");
    const oneTimeSecret = "rc_pair_secret_correct";
    const proof = sign(null, pairingProofMessage("rc_pair_1", oneTimeSecret), wrongSigning.privateKey).toString("base64url");
    const store = memoryStore();
    store.record = pairingRecord({
      signingPublicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
      oneTimeSecret
    });

    await expect(exchangePairing({ store, pairingId: "rc_pair_1", oneTimeSecret, proof, now })).resolves.toEqual({ kind: "invalid" });
    await expect(exchangePairing({ store, pairingId: "rc_pair_1", oneTimeSecret: "rc_pair_secret_wrong", proof, now })).resolves.toEqual({ kind: "invalid" });
    expect(store.recordFailedExchange).toHaveBeenCalledTimes(2);

    store.record = pairingRecord({ oneTimeSecret, expiresAt: new Date(now.getTime() - 1) });
    await expect(exchangePairing({ store, pairingId: "rc_pair_1", oneTimeSecret, proof, now })).resolves.toEqual({ kind: "invalid" });

    store.record = pairingRecord({ oneTimeSecret, status: "consumed" });
    await expect(exchangePairing({ store, pairingId: "rc_pair_1", oneTimeSecret, proof, now })).resolves.toEqual({ kind: "invalid" });
  });

  it("rejects malformed keys and unsafe machine metadata before persistence", async () => {
    const store = memoryStore();
    const { signingPublicKey, encryptionPublicKey } = devicePublicKeys();

    await expect(
      createPairing({
        store,
        publicBaseUrl: "https://prism.example.test",
        ...pairingSource,
        signingPublicKey: encryptionPublicKey,
        encryptionPublicKey,
        machineLabel: "Workstation",
        companionVersion: "0.1.0",
        now
      })
    ).rejects.toThrow("invalid-signing-key");
    await expect(
      createPairing({
        store,
        publicBaseUrl: "https://prism.example.test",
        ...pairingSource,
        signingPublicKey,
        encryptionPublicKey,
        machineLabel: "Workstation\nsecret",
        companionVersion: "0.1.0",
        now
      })
    ).rejects.toThrow("invalid-machine-label");
    expect(store.savePairing).not.toHaveBeenCalled();
  });
});

function memoryStore(): PairingStore & {
  record: PairingRecord | null;
  savePairing: ReturnType<typeof vi.fn>;
  approvePairing: ReturnType<typeof vi.fn>;
  recordFailedExchange: ReturnType<typeof vi.fn>;
  completeExchange: ReturnType<typeof vi.fn>;
} {
  const store = {
    record: null as PairingRecord | null,
    savePairing: vi.fn(async (record: PairingRecord) => {
      store.record = record;
    }),
    getPairing: vi.fn(async () => store.record),
    approvePairing: vi.fn(async ({ pairingId, targetTeamId }: { pairingId: string; targetTeamId: string }) => {
      if (!store.record || store.record.id !== pairingId || store.record.status !== "pending") return { kind: "invalid" } as const;
      const slackConnectionId = "connection-owner";
      store.record = { ...store.record, status: "approved", approvedPrismUserId: "owner_1", approvedSlackConnectionId: slackConnectionId, approvedTeamId: targetTeamId };
      return { kind: "approved", machineLabel: store.record.machineLabel, slackConnectionId } as const;
    }),
    recordFailedExchange: vi.fn(async () => undefined),
    completeExchange: vi.fn(async ({ pairingId, secretHash }: { pairingId: string; secretHash: string }) => {
      if (!store.record || store.record.id !== pairingId || store.record.secretHash !== secretHash || store.record.status !== "approved") return null;
      store.record = { ...store.record, status: "consumed" };
      return { installationId: "installation_1" };
    })
  };
  return store;
}

function pairingRecord(overrides: Partial<PairingRecord> & { oneTimeSecret?: string } = {}): PairingRecord {
  const keys = devicePublicKeys();
  const { oneTimeSecret = "rc_pair_secret_default", ...recordOverrides } = overrides;
  return {
    id: "rc_pair_1",
    secretHash: hashForTest(oneTimeSecret),
    signingPublicKey: keys.signingPublicKey,
    encryptionPublicKey: keys.encryptionPublicKey,
    machineLabel: "Jill's Workstation",
    companionVersion: "0.1.0",
    verificationPhrase: "violet-river-42",
    sourceKey: "a".repeat(64),
    sourceAttributed: true,
    signingKeyFingerprint: "b".repeat(64),
    status: "approved",
    expiresAt: new Date(now.getTime() + 60_000),
    approvedPrismUserId: "owner_1",
    approvedSlackConnectionId: "connection-owner",
    approvedTeamId: "T123",
    ...recordOverrides
  };
}

const pairingSource = {
  sourceIdentifier: "203.0.113.10",
  sourceKey: "a".repeat(64)
};

function devicePublicKeys() {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return {
    signingPublicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
    encryptionPublicKey: encryption.publicKey.export({ format: "pem", type: "spki" }).toString()
  };
}

function deterministicRandom(size: number): Buffer {
  return Buffer.alloc(size, 7);
}

function hashForTest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
