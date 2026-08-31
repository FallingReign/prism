import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(async (callback: (database: unknown) => Promise<unknown>) => callback(mockDb))
}));

vi.mock("@/src/server/db", () => ({ database: mockDb }));

describe("POST /v1/prism/remote-codex/pairings/{pairingId}/approve", () => {
  const pairingId = "rc_pair_1";
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.transaction.mockClear();
    process.env.PRISM_PUBLIC_BASE_URL = "https://prism.example.test";
    process.env.PRISM_REMOTE_CODEX_ENABLED = "1";
  });

  it("approves the explicitly selected owner connection and redirects to a friendly success page", async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from remote_codex_pairing_requests")) return { rows: [pairingRow()], rowCount: 1 };
      if (sql.includes("from prism_sessions")) return { rows: [{ prism_user_id: "owner_1", slack_connection_id: "connection-owner" }], rowCount: 1 };
      if (sql.includes("update remote_codex_pairing_requests")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const { POST } = await import("./route");
    const response = await POST(request({ origin: "https://prism.example.test" }), { params: Promise.resolve({ pairingId }) });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`https://prism.example.test/remote-codex/pair/${pairingId}?connected=1`);
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("update remote_codex_pairing_requests"))).toBe(true);
  });

  it("rejects cross-origin posts before any database mutation", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({ origin: "https://evil.example.test" }), { params: Promise.resolve({ pairingId }) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "csrf_rejected" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

function request({ origin }: { origin: string }): NextRequest {
  const form = new URLSearchParams({ teamId: "T123" });
  return new NextRequest("https://prism.example.test/v1/prism/remote-codex/pairings/rc_pair_1/approve", {
    method: "POST",
    headers: {
      origin,
      cookie: "prism_session=website-session",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form
  });
}

function pairingRow() {
  return {
    id: "rc_pair_1",
    secret_hash: "a".repeat(64),
    signing_public_key: "signing-public-key",
    encryption_public_key: "encryption-public-key",
    machine_label: "Workstation",
    companion_version: "0.1.0",
    verification_phrase: "violet-river-42",
    source_key: "a".repeat(64),
    source_attributed: false,
    signing_key_fingerprint: "b".repeat(64),
    status: "pending",
    expires_at: new Date("2099-01-01T00:00:00.000Z"),
    approved_prism_user_id: null,
    approved_slack_connection_id: null,
    approved_team_id: null
  };
}
