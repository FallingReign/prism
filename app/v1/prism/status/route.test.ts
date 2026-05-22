import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>()
}));

vi.mock("../../../../src/server/db", () => ({ database: mockDb }));

const capabilityMap = {
  version: 1,
  preset: "messages_only",
  workspaces: { mode: "linked_slack_connection" },
  surfaces: {
    publicChannels: true,
    privateChannels: true,
    directMessages: true,
    groupDirectMessages: true,
    search: false,
    filesMetadata: false,
    canvases: false,
    lists: false,
    future: false
  },
  actions: { read: true, search: false, writeMessages: true, reactions: true, filesMetadata: false, destructive: false },
  executionIdentity: "user",
  experiment: { enabled: false, ttl: null },
  mutation: { destructiveOptIn: false, narrowingAppliesImmediately: true, broadeningRequiresRotation: true },
  deferred: { admin: false, fileTransfer: false, events: false, slashCommands: false, interactivity: false, canvases: false, lists: false }
};

describe("GET /v1/prism/status", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER = "pepper-secret-canary";
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER_ID = "test-pepper";
    mockDb.query.mockResolvedValue({
      rows: [
        {
          token_profile_id: "profile_1",
          token_expires_at: new Date("2027-04-01T00:00:00.000Z"),
          token_revoked_at: null,
          profile_status: "active",
          profile_expires_at: new Date("2027-04-01T00:00:00.000Z"),
          preset: "messages_only",
          capability_map: capabilityMap,
          slack_status: "healthy",
          slack_last_error_class: null,
          has_user_credential: true,
          has_bot_credential: true
        }
      ],
      rowCount: 1
    });
  });

  it("reports active token status with request IDs, no-store, and no secret material", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost:3732/v1/prism/status", {
        headers: { authorization: "Bearer prism_dev_statuscanarystatuscanarystatuscanary" }
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBe(body.requestId);
    expect(body).toMatchObject({
      token: { valid: true, status: "active", tokenProfileId: "profile_1" },
      slack: { status: "healthy", reauthRequired: false },
      executionIdentity: { configured: "user", available: true }
    });
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary|xox[bp]-|refresh|access_token|client_secret/i);
  });

  it("returns a machine-readable invalid status for missing or malformed bearer tokens", async () => {
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost:3732/v1/prism/status"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ token: { valid: false, status: "invalid" } });
    expect(response.headers.get("x-prism-request-id")).toBe(body.requestId);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("maps expired, revoked, Reauth required, and missing identity states", async () => {
    const { GET } = await import("./route");

    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...activeRow(), token_expires_at: new Date("2026-01-01T00:00:00.000Z") }],
      rowCount: 1
    });
    const expired = await GET(
      new NextRequest("http://localhost:3732/v1/prism/status", {
        headers: { authorization: "Bearer prism_dev_expiredroutetestexpiredroutetest" }
      })
    );

    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...activeRow(), token_revoked_at: new Date("2026-01-01T00:00:00.000Z") }],
      rowCount: 1
    });
    const revoked = await GET(
      new NextRequest("http://localhost:3732/v1/prism/status", {
        headers: { authorization: "Bearer prism_dev_revokedroutetestrevokedroutetest" }
      })
    );

    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...activeRow(), slack_status: "reauth_required", slack_last_error_class: "invalid_refresh_token" }],
      rowCount: 1
    });
    const reauth = await GET(
      new NextRequest("http://localhost:3732/v1/prism/status", {
        headers: { authorization: "Bearer prism_dev_reauthroutetestreauthroutetestcanary" }
      })
    );

    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          ...activeRow(),
          capability_map: { ...capabilityMap, executionIdentity: "bot" },
          has_bot_credential: false
        }
      ],
      rowCount: 1
    });
    const missingBot = await GET(
      new NextRequest("http://localhost:3732/v1/prism/status", {
        headers: { authorization: "Bearer prism_dev_missingbotroutetestmissingbotroute" }
      })
    );

    expect(expired.status).toBe(401);
    expect((await expired.json()).token).toMatchObject({ valid: false, status: "expired" });
    expect(revoked.status).toBe(403);
    expect((await revoked.json()).token).toMatchObject({ valid: false, status: "revoked" });
    expect(reauth.status).toBe(200);
    expect(await reauth.json()).toMatchObject({
      slack: { status: "reauth_required", reauthRequired: true, lastErrorClass: "reauth_required" },
      executionIdentity: { available: false, unavailableReason: "slack_reauth_required" }
    });
    expect(missingBot.status).toBe(200);
    expect(await missingBot.json()).toMatchObject({
      executionIdentity: { configured: "bot", available: false, unavailableReason: "missing_bot_identity" }
    });
  });
});

function activeRow() {
  return {
    token_profile_id: "profile_1",
    token_expires_at: new Date("2027-04-01T00:00:00.000Z"),
    token_revoked_at: null,
    profile_status: "active",
    profile_expires_at: new Date("2027-04-01T00:00:00.000Z"),
    preset: "messages_only",
    capability_map: capabilityMap,
    slack_status: "healthy",
    slack_last_error_class: null,
    has_user_credential: true,
    has_bot_credential: true
  };
}
