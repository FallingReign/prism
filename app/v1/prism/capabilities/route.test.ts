import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>()
}));

vi.mock("../../../../src/server/db", () => ({ database: mockDb }));

const capabilityMap = {
  version: 1,
  preset: "read_only",
  workspaces: { mode: "linked_slack_connection" },
  surfaces: {
    publicChannels: true,
    privateChannels: true,
    directMessages: true,
    groupDirectMessages: true,
    search: true,
    filesMetadata: false,
    canvases: false,
    lists: false,
    future: false
  },
  actions: { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false },
  executionIdentity: "automatic",
  experiment: { enabled: false, ttl: null },
  mutation: { destructiveOptIn: false, narrowingAppliesImmediately: true, broadeningRequiresRotation: true },
  deferred: { admin: false, fileTransfer: false, events: false, slashCommands: false, interactivity: false, canvases: false, lists: false }
};

describe("GET /v1/prism/capabilities", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER = "pepper-secret-canary";
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER_ID = "test-pepper";
    mockDb.query.mockResolvedValue({
      rows: [
        {
          token_profile_id: "profile_read",
          token_expires_at: null,
          token_revoked_at: null,
          profile_status: "active",
          profile_expires_at: null,
          preset: "read_only",
          capability_map: capabilityMap,
          slack_status: "healthy",
          slack_last_error_class: null,
          has_user_credential: true,
          has_bot_credential: true,
          token_last_used_at: null,
          token_overlap_expires_at: null,
          token_is_current: true
        }
      ],
      rowCount: 1
    });
  });

  it("reports effective capability and Method registry discovery without secret material", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost:3732/v1/prism/capabilities", {
        headers: { authorization: "Bearer prism_dev_capabilitycanarycapabilitycanary" }
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBe(body.requestId);
    expect(body).toMatchObject({
      token: { status: "active", tokenProfileId: "profile_read" },
      capabilityMap: { preset: "read_only", actions: { read: true, search: true, writeMessages: false } },
      categories: { "conversations.read": { allowed: true }, "messages.write": { allowed: false } },
      methods: { "conversations.history": { status: "allowed" }, "chat.postMessage": { status: "denied" } }
    });
    expect(body.unsupported.surfaces).toEqual(expect.arrayContaining(["admin", "events", "fileTransfer", "canvases", "lists"]));
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary|xox[bp]-|refresh|access_token|client_secret/i);
  });

  it("does not return capabilities for invalid bearer tokens", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost:3732/v1/prism/capabilities", {
        headers: { authorization: "Bearer prism_dev_invalid" }
      })
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ token: { valid: false, status: "invalid" } });
    expect(body.capabilityMap).toBeUndefined();
    expect(body.methods).toBeUndefined();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("does not return capability maps for expired or revoked developer tokens", async () => {
    const { GET } = await import("./route");
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          ...activeRow(),
          token_expires_at: new Date("2025-12-31T23:45:00.000Z"),
          token_overlap_expires_at: new Date("2025-12-31T23:45:00.000Z"),
          token_is_current: false
        }
      ],
      rowCount: 1
    });
    const expired = await GET(
      new NextRequest("http://localhost:3732/v1/prism/capabilities", {
        headers: { authorization: "Bearer prism_dev_expiredcapabilityroutecanaryxxxx" }
      })
    );

    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...activeRow(), token_revoked_at: new Date("2026-01-01T00:00:00.000Z") }],
      rowCount: 1
    });
    const revoked = await GET(
      new NextRequest("http://localhost:3732/v1/prism/capabilities", {
        headers: { authorization: "Bearer prism_dev_revokedcapabilityroutecanaryxxxx" }
      })
    );
    const expiredBody = await expired.json();
    const revokedBody = await revoked.json();

    expect(expired.status).toBe(401);
    expect(expiredBody).toMatchObject({ token: { valid: false, status: "expired", tokenProfileId: "profile_read" } });
    expect(expiredBody.capabilityMap).toBeUndefined();
    expect(expiredBody.methods).toBeUndefined();
    expect(revoked.status).toBe(403);
    expect(revokedBody).toMatchObject({ token: { valid: false, status: "revoked", tokenProfileId: "profile_read" } });
    expect(revokedBody.capabilityMap).toBeUndefined();
    expect(revokedBody.methods).toBeUndefined();
    expect(JSON.stringify({ expiredBody, revokedBody })).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary|xox[bp]-|refresh|access_token|client_secret/i);
  });
});

function activeRow() {
  return {
    token_profile_id: "profile_read",
    token_expires_at: null,
    token_revoked_at: null,
    token_last_used_at: null,
    token_overlap_expires_at: null,
    token_is_current: true,
    profile_status: "active",
    profile_expires_at: null,
    preset: "read_only",
    capability_map: capabilityMap,
    slack_status: "healthy",
    slack_last_error_class: null,
    has_user_credential: true,
    has_bot_credential: true
  };
}
