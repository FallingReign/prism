import { generateKeyPairSync, sign } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { runnerProofMessage } from "@/src/server/remote-codex/runner-auth";

const mockDb = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(async (callback: (database: unknown) => Promise<unknown>) => callback(mockDb))
}));
const scheduled = vi.hoisted(() => [] as Array<() => Promise<void>>);

vi.mock("@/src/server/db", () => ({ database: mockDb }));
vi.mock("@/src/server/http/deferred-work", () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => scheduled.push(task)
}));
vi.mock("@/src/server/remote-codex/internal-slack-service", () => ({
  createDefaultRemoteCodexSlackService: async () => ({ call: vi.fn() })
}));
vi.mock("@/src/server/remote-codex/slack-rate-limit", () => ({
  createRemoteCodexSlackRateLimiter: () => vi.fn()
}));

describe("POST /v1/prism/remote-codex/runner/sessions", () => {
  let signing: ReturnType<typeof generateKeyPairSync>;

  beforeEach(() => {
    vi.resetModules();
    process.env.PRISM_REMOTE_CODEX_ENABLED = "1";
    process.env.PRISM_PUBLIC_BASE_URL = "https://prism.example.test";
    mockDb.query.mockReset();
    mockDb.transaction.mockClear();
    scheduled.length = 0;
    signing = generateKeyPairSync("ed25519");
  });

  it("authenticates the exact raw body before syncing its safe catalog projection", async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("remote_codex_installation_credentials")) {
        return {
          rows: [
            {
              installation_id: "rc_install_1",
              prism_user_id: "owner_1",
              slack_connection_id: "connection-owner",
              signing_public_key: signing.publicKey.export({ format: "pem", type: "spki" }).toString()
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const body = JSON.stringify({
      catalogVersion: "catalog_1",
      sessions: [{ threadId: "thread_1", title: "Ship companion", projectLabel: "remote-codex", status: "ready", lastActivity: 1788145200 }]
    });
    const { POST } = await import("./route");
    const response = await POST(signedRequest(body, signing));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "synced", count: 1, bindingsUpdateScheduled: true });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("insert into remote_codex_sessions"))).toBe(true);
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("from remote_codex_slack_bindings"))).toBe(false);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.();
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("from remote_codex_slack_bindings"))).toBe(true);
  });

  it("rejects a body changed after signing before catalog persistence", async () => {
    mockDb.query.mockResolvedValue({
      rows: [
        {
          installation_id: "rc_install_1",
          prism_user_id: "owner_1",
          slack_connection_id: "connection-owner",
          signing_public_key: signing.publicKey.export({ format: "pem", type: "spki" }).toString()
        }
      ],
      rowCount: 1
    });
    const request = signedRequest(JSON.stringify({ catalogVersion: "catalog_1", sessions: [] }), signing);
    const headers = new Headers(request.headers);
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ catalogVersion: "catalog_2", sessions: [] })
      })
    );

    expect(response.status).toBe(401);
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("insert into remote_codex_sessions"))).toBe(false);
  });
});

function signedRequest(body: string, signing: ReturnType<typeof generateKeyPairSync>): NextRequest {
  const timestamp = new Date().toISOString();
  const proof = {
    method: "POST",
    path: "/v1/prism/remote-codex/runner/sessions",
    body,
    installationId: "rc_install_1",
    accessToken: "rc_access_abcdefghijklmnopqrstuvwxyz123456",
    timestamp,
    nonce: "nonce_1234567890abcdef"
  };
  return new NextRequest(`https://prism.example.test${proof.path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${proof.accessToken}`,
      "content-type": "application/json",
      "x-prism-installation-id": proof.installationId,
      "x-prism-timestamp": timestamp,
      "x-prism-nonce": proof.nonce,
      "x-prism-signature": sign(null, runnerProofMessage(proof), signing.privateKey).toString("base64url")
    },
    body
  });
}
