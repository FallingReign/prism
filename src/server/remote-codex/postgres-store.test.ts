import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { hashSecret, type PairingRecord } from "./pairing-service";
import { createPostgresPairingStore } from "./postgres-store";

const now = new Date("2026-08-31T05:00:00.000Z");

describe("remote Codex Postgres pairing store", () => {
  it("persists pending pairing metadata without the one-time secret", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("insert into remote_codex_pairing_create_limits")) return { rows: [{ request_count: 1 }], rowCount: 1 };
      if (sql.includes("select count(*)")) return { rows: [{ global_count: 0, source_count: 0, signing_count: 0 }], rowCount: 1 };
      if (!sql.includes("insert into remote_codex_pairing_requests")) return { rows: [], rowCount: 1 };
      expect(sql).toContain("insert into remote_codex_pairing_requests");
      expect(sql).not.toMatch(/one_time_secret|access_token\b|refresh_token\b/i);
      expect(params).toEqual([
        "rc_pair_1",
        hashSecret("rc_pair_secret_1"),
        "signing-public-key",
        "encryption-public-key",
        "Workstation",
        "0.1.0",
        "violet-river-42",
        "a".repeat(64),
        true,
        "b".repeat(64),
        new Date("2026-08-31T05:10:00.000Z")
      ]);
      return { rows: [], rowCount: 1 };
    });

    await createPostgresPairingStore(fakeDatabase(query)).savePairing(record());
    expect(query.mock.calls.some(([sql]) => String(sql).includes("remote_codex_pairing_create_limit"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("delete from remote_codex_pairing_requests"))).toBe(true);
  });

  it("does not put unattributed clients into one low shared source bucket", async () => {
    const buckets: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("insert into remote_codex_pairing_create_limits")) {
        buckets.push(String(params?.[0]));
        return { rows: [{ request_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("select count(*)")) return { rows: [{ global_count: 0, source_count: 0, signing_count: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    await createPostgresPairingStore(fakeDatabase(query)).savePairing(record({ sourceAttributed: false }));
    expect(buckets).toEqual(["global", "signing_key"]);
  });

  it("enforces the canonical signing-key rate bucket before persistence", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("insert into remote_codex_pairing_create_limits")) {
        return { rows: [{ request_count: params?.[0] === "signing_key" ? 6 : 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(createPostgresPairingStore(fakeDatabase(query)).savePairing(record())).rejects.toThrow("pairing-rate-limit");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into remote_codex_pairing_requests"))).toBe(false);
  });

  it("retains a final global outstanding-pairing circuit breaker", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("insert into remote_codex_pairing_create_limits")) return { rows: [{ request_count: 1 }], rowCount: 1 };
      if (sql.includes("select count(*)")) return { rows: [{ global_count: 1_000, source_count: 0, signing_count: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    await expect(createPostgresPairingStore(fakeDatabase(query)).savePairing(record())).rejects.toThrow("pairing-capacity");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into remote_codex_pairing_requests"))).toBe(false);
  });

  it("approves only an exact healthy Slack connection owned by the current browser session", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from remote_codex_pairing_requests") && sql.includes("for update")) {
        return { rows: [pairingRow({ status: "pending" })], rowCount: 1 };
      }
      if (sql.includes("from prism_sessions")) {
        expect(params).toEqual([hashSecret("website-session"), now, "T123"]);
        expect(sql).toContain("s.slack_connection_id");
        return { rows: [{ prism_user_id: "owner_1", slack_connection_id: "connection-owner" }], rowCount: 1 };
      }
      if (sql.includes("update remote_codex_pairing_requests")) {
        expect(params).toEqual(["rc_pair_1", "owner_1", "connection-owner", "T123", now]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(
      createPostgresPairingStore(fakeDatabase(query)).approvePairing({
        pairingId: "rc_pair_1",
        sessionTokenHash: hashSecret("website-session"),
        targetTeamId: "T123",
        now
      })
    ).resolves.toEqual({ kind: "approved", machineLabel: "Workstation", slackConnectionId: "connection-owner" });
  });

  it("fails closed when the selected Slack connection belongs to a different user", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from remote_codex_pairing_requests")) return { rows: [pairingRow({ status: "pending" })], rowCount: 1 };
      if (sql.includes("from prism_sessions")) return { rows: [], rowCount: 0 };
      throw new Error("approval must not update after ownership failure");
    });

    await expect(
      createPostgresPairingStore(fakeDatabase(query)).approvePairing({
        pairingId: "rc_pair_1",
        sessionTokenHash: hashSecret("website-session"),
        targetTeamId: "T999",
        now
      })
    ).resolves.toEqual({ kind: "wrong_owner" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("update remote_codex_pairing_requests"))).toBe(false);
  });

  it("atomically consumes an approved pairing into one installation and hash-only credentials", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/rc_access_|rc_refresh_|rc_pair_secret_/);
      if (sql.includes("from remote_codex_pairing_requests") && sql.includes("for update")) {
        expect(params).toEqual(["rc_pair_1"]);
        return { rows: [pairingRow({ status: "approved" })], rowCount: 1 };
      }
      if (sql.includes("insert into remote_codex_installations")) {
        expect(params).toEqual([
          "rc_install_fixed",
          "owner_1",
          "connection-owner",
          "signing-public-key",
          "encryption-public-key",
          "T123",
          "Workstation",
          "0.1.0",
          now
        ]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into remote_codex_installation_credentials")) {
        expect(params?.[0]).toBe("rc_install_fixed");
        expect(params?.[1]).toMatch(/^[a-f0-9]{64}$/);
        expect(params?.[3]).toMatch(/^[a-f0-9]{64}$/);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update remote_codex_pairing_requests")) {
        expect(params).toEqual(["rc_pair_1", hashSecret("rc_pair_secret_1"), now]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(
      createPostgresPairingStore(fakeDatabase(query), { installationId: () => "rc_install_fixed", credentialFamilyId: () => "family_fixed" }).completeExchange({
        pairingId: "rc_pair_1",
        secretHash: hashSecret("rc_pair_secret_1"),
        accessTokenHash: hashSecret("rc_access_1"),
        accessTokenExpiresAt: new Date("2026-08-31T05:15:00.000Z"),
        refreshTokenHash: hashSecret("rc_refresh_1"),
        refreshTokenExpiresAt: new Date("2026-09-30T05:00:00.000Z"),
        now
      })
    ).resolves.toEqual({ installationId: "rc_install_fixed" });
  });

  it("counts failed exchanges and expires the pairing at the bounded attempt limit", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("attempt_count = attempt_count + 1");
      expect(sql).toContain("attempt_count + 1 >= 20");
      expect(params).toEqual(["rc_pair_1", now]);
      return { rows: [], rowCount: 1 };
    });
    await createPostgresPairingStore(fakeDatabase(query)).recordFailedExchange({ pairingId: "rc_pair_1", now });
  });
});

function record(overrides: Partial<PairingRecord> = {}): PairingRecord {
  return {
    id: "rc_pair_1",
    secretHash: hashSecret("rc_pair_secret_1"),
    signingPublicKey: "signing-public-key",
    encryptionPublicKey: "encryption-public-key",
    machineLabel: "Workstation",
    companionVersion: "0.1.0",
    verificationPhrase: "violet-river-42",
    sourceKey: "a".repeat(64),
    sourceAttributed: true,
    signingKeyFingerprint: "b".repeat(64),
    status: "pending",
    expiresAt: new Date("2026-08-31T05:10:00.000Z"),
    approvedPrismUserId: null,
    approvedSlackConnectionId: null,
    approvedTeamId: null,
    ...overrides
  };
}

function pairingRow(overrides: Record<string, unknown>) {
  return {
    id: "rc_pair_1",
    secret_hash: hashSecret("rc_pair_secret_1"),
    signing_public_key: "signing-public-key",
    encryption_public_key: "encryption-public-key",
    machine_label: "Workstation",
    companion_version: "0.1.0",
    verification_phrase: "violet-river-42",
    source_key: "a".repeat(64),
    source_attributed: true,
    signing_key_fingerprint: "b".repeat(64),
    status: "approved",
    expires_at: new Date("2026-08-31T05:10:00.000Z"),
    approved_prism_user_id: "owner_1",
    approved_slack_connection_id: "connection-owner",
    approved_team_id: "T123",
    ...overrides
  };
}

function fakeDatabase(query: ReturnType<typeof vi.fn>): Database {
  const value: Database = { query: query as unknown as Database["query"], transaction: async (callback) => callback(value) };
  return value;
}
