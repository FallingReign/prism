import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(async (callback: (database: unknown) => Promise<unknown>) => callback(mockDb))
}));

vi.mock("../../../../../src/server/db", () => ({ database: mockDb }));

describe("POST /v1/prism/remote-codex/pairings", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.transaction.mockClear();
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into remote_codex_pairing_create_limits")) return { rows: [{ request_count: 1 }], rowCount: 1 };
      if (sql.includes("select count(*)")) return { rows: [{ global_count: 0, source_count: 0, signing_count: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    process.env.PRISM_PUBLIC_BASE_URL = "https://prism.example.test";
    process.env.PRISM_REMOTE_CODEX_ENABLED = "1";
    process.env.PRISM_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    process.env.PRISM_CREDENTIAL_ENCRYPTION_KEY_ID = "pairing-route-test";
  });

  it("returns a no-store browser approval and a copy-once pairing secret", async () => {
    const { signingPublicKey, encryptionPublicKey } = publicKeys();
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("https://prism.example.test/v1/prism/remote-codex/pairings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signingPublicKey, encryptionPublicKey, machineLabel: "Workstation", companionVersion: "0.1.0" })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      pairingId: expect.stringMatching(/^rc_pair_/),
      oneTimeSecret: expect.stringMatching(/^rc_pair_secret_/),
      approvalUrl: expect.stringMatching(/^https:\/\/prism\.example\.test\/remote-codex\/pair\/rc_pair_/),
      verificationPhrase: expect.stringMatching(/^[a-z]+-[a-z]+-\d{2}$/)
    });
    expect(body.approvalUrl).not.toContain(body.oneTimeSecret);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain(body.oneTimeSecret);
  });

  it("rejects invalid JSON and keys without persisting", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("https://prism.example.test/v1/prism/remote-codex/pairings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signingPublicKey: "not-a-key", encryptionPublicKey: "not-a-key", machineLabel: "Workstation", companionVersion: "0.1.0" })
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_pairing_request" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

function publicKeys() {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return {
    signingPublicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
    encryptionPublicKey: encryption.publicKey.export({ format: "pem", type: "spki" }).toString()
  };
}
