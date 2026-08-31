import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { pairingProofMessage } from "../../../../../../src/server/remote-codex/pairing-service";

const mockDb = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(async (callback: (database: unknown) => Promise<unknown>) => callback(mockDb))
}));

vi.mock("../../../../../../src/server/db", () => ({ database: mockDb }));

const pairingId = "rc_pair_1";
const oneTimeSecret = "rc_pair_secret_copy-once";

describe("POST /v1/prism/remote-codex/runner/token", () => {
  let signing: ReturnType<typeof generateKeyPairSync>;

  beforeEach(() => {
    vi.resetModules();
    process.env.PRISM_REMOTE_CODEX_ENABLED = "1";
    process.env.PRISM_PUBLIC_BASE_URL = "https://prism.example.test";
    mockDb.query.mockReset();
    mockDb.transaction.mockClear();
    signing = generateKeyPairSync("ed25519");
  });

  it("exchanges an approved key proof into hash-only installation credentials", async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from remote_codex_pairing_requests")) return { rows: [pairingRow(signing)], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const proof = sign(null, pairingProofMessage(pairingId, oneTimeSecret), signing.privateKey).toString("base64url");
    const { POST } = await import("./route");
    const response = await POST(request({ pairingId, oneTimeSecret, proof }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      status: "connected",
      installationId: expect.stringMatching(/^rc_install_/),
      accessToken: expect.stringMatching(/^rc_access_/),
      refreshToken: expect.stringMatching(/^rc_refresh_/)
    });
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain(body.accessToken);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain(body.refreshToken);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain(oneTimeSecret);
  });

  it("returns a generic invalid response for a bad signature", async () => {
    mockDb.query.mockResolvedValue({ rows: [pairingRow(signing)], rowCount: 1 });
    const wrongKey = generateKeyPairSync("ed25519");
    const proof = sign(null, pairingProofMessage(pairingId, oneTimeSecret), wrongKey.privateKey).toString("base64url");
    const { POST } = await import("./route");
    const response = await POST(request({ pairingId, oneTimeSecret, proof }));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_pairing" });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("remote_codex_installations"))).toBe(false);
  });
});

function request(body: unknown): NextRequest {
  return new NextRequest("https://prism.example.test/v1/prism/remote-codex/runner/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function pairingRow(signing: ReturnType<typeof generateKeyPairSync>) {
  return {
    id: pairingId,
    secret_hash: createHash("sha256").update(oneTimeSecret).digest("hex"),
    signing_public_key: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
    encryption_public_key: generateKeyPairSync("x25519").publicKey.export({ format: "pem", type: "spki" }).toString(),
    machine_label: "Workstation",
    companion_version: "0.1.0",
    verification_phrase: "violet-river-42",
    source_key: "a".repeat(64),
    source_attributed: false,
    signing_key_fingerprint: "b".repeat(64),
    status: "approved",
    expires_at: new Date("2099-01-01T00:00:00.000Z"),
    approved_prism_user_id: "owner_1",
    approved_slack_connection_id: "connection-owner",
    approved_team_id: "T123"
  };
}
