import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { hashSecret } from "./pairing-service";
import { createPostgresCredentialRefreshStore, createPostgresRunnerAuthStore, createPostgresSessionCatalogStore } from "./runner-postgres-store";

const now = new Date("2026-08-31T07:00:00.000Z");

describe("remote Codex runner Postgres stores", () => {
  it("resolves only a non-revoked exact installation and short-lived access hash", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("remote_codex_installation_credentials");
      expect(sql).toContain("i.revoked_at is null");
      expect(sql).toContain("c.access_token_expires_at > $3");
      expect(params).toEqual(["rc_install_1", hashSecret("rc_access_1"), now]);
      return {
        rows: [
          {
            installation_id: "rc_install_1",
            prism_user_id: "owner_1",
            slack_connection_id: "connection-owner",
            signing_public_key: "signing-public-key"
          }
        ],
        rowCount: 1
      };
    });

    await expect(
      createPostgresRunnerAuthStore(fakeDatabase(query)).resolveAccess({
        installationId: "rc_install_1",
        accessTokenHash: hashSecret("rc_access_1"),
        now
      })
    ).resolves.toEqual({
      installationId: "rc_install_1",
      prismUserId: "owner_1",
      slackConnectionId: "connection-owner",
      signingPublicKey: "signing-public-key"
    });
  });

  it("claims each nonce once before marking the installation online", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("delete from remote_codex_request_nonces")) {
        expect(params).toEqual([now]);
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes("insert into remote_codex_request_nonces")) {
        expect(sql).toContain("on conflict do nothing");
        expect(params).toEqual([
          "rc_install_1",
          "nonce_1234567890abcdef",
          now,
          new Date("2026-08-31T07:05:00.000Z")
        ]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update remote_codex_installations")) {
        expect(params).toEqual(["rc_install_1", now]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(
      createPostgresRunnerAuthStore(fakeDatabase(query)).claimNonce({
        installationId: "rc_install_1",
        nonce: "nonce_1234567890abcdef",
        requestTimestamp: now,
        expiresAt: new Date("2026-08-31T07:05:00.000Z"),
        now
      })
    ).resolves.toBe(true);
  });

  it("upserts only safe session metadata and marks prior catalog entries unavailable", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/\bcwd\b|preview|prompt|output|diff|transcript/i);
      if (sql.includes("insert into remote_codex_sessions")) {
        expect(params).toEqual([
          "rc_install_1",
          "thread_1",
          "Ship the companion",
          "remote-codex",
          "ready",
          new Date("2026-08-31T05:40:00.000Z"),
          "catalog_1",
          now
        ]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update remote_codex_sessions")) {
        expect(params).toEqual(["rc_install_1", "catalog_1", now]);
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("update remote_codex_installations")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });

    await createPostgresSessionCatalogStore(fakeDatabase(query)).replaceCatalog({
      installationId: "rc_install_1",
      catalogVersion: "catalog_1",
      sessions: [
        {
          threadId: "thread_1",
          title: "Ship the companion",
          projectLabel: "remote-codex",
          status: "ready",
          lastActivity: new Date("2026-08-31T05:40:00.000Z")
        }
      ],
      now
    });
  });

  it("rotates refresh hashes under a row lock and records the used hash for reuse revocation", async () => {
    const oldHash = hashSecret("rc_refresh_old-token-value");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("refresh_family_id") && sql.includes("for update")) {
        return {
          rows: [
            {
              installation_id: "rc_install_1",
              signing_public_key: "signing-public-key",
              refresh_token_hash: oldHash,
              refresh_family_id: "family_1",
              refresh_rotation: 2,
              refresh_token_expires_at: new Date("2026-09-30T07:00:00.000Z")
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes("insert into remote_codex_refresh_token_history")) {
        expect(params).toEqual(["rc_install_1", "family_1", oldHash, 2, now]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update remote_codex_installation_credentials")) {
        expect(params?.[0]).toBe("rc_install_1");
        expect(params?.[1]).toMatch(/^[a-f0-9]{64}$/);
        expect(params?.[3]).toMatch(/^[a-f0-9]{64}$/);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(
      createPostgresCredentialRefreshStore(fakeDatabase(query)).rotate({
        installationId: "rc_install_1",
        presentedRefreshTokenHash: oldHash,
        nextAccessTokenHash: hashSecret("rc_access_next-token-value"),
        nextAccessTokenExpiresAt: new Date("2026-08-31T07:15:00.000Z"),
        nextRefreshTokenHash: hashSecret("rc_refresh_next-token-value"),
        nextRefreshTokenExpiresAt: new Date("2026-09-30T07:00:00.000Z"),
        now
      })
    ).resolves.toBe("rotated");
  });
});

function fakeDatabase(query: ReturnType<typeof vi.fn>): Database {
  const value: Database = { query: query as unknown as Database["query"], transaction: async (callback) => callback(value) };
  return value;
}
