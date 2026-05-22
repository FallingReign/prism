import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>()
}));

vi.mock("../../../../../src/server/db", () => ({ database: mockDb }));

function capabilityMap(overrides: Record<string, unknown> = {}) {
  return {
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
    actions: { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false, ...overrides },
    executionIdentity: "automatic",
    experiment: { enabled: false, ttl: null },
    mutation: { destructiveOptIn: false, narrowingAppliesImmediately: true, broadeningRequiresRotation: true },
    deferred: { admin: false, fileTransfer: false, events: false, slashCommands: false, interactivity: false, canvases: false, lists: false }
  };
}

function row(map = capabilityMap()) {
  return {
    token_profile_id: "profile_1",
    token_expires_at: null,
    token_revoked_at: null,
    profile_status: "active",
    profile_expires_at: null,
    preset: map.preset,
    capability_map: map,
    slack_status: "healthy",
    slack_team_id: "T123",
    slack_last_error_class: null,
    has_user_credential: true,
    has_bot_credential: true
  };
}

describe("/v1/slack/api/[method] policy tracer", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER = "pepper-secret-canary";
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER_ID = "test-pepper";
    mockDb.query.mockResolvedValue({ rows: [row()], rowCount: 1 });
  });

  it("returns Slack-compatible denied diagnostics for policy-denied methods without exposing secrets", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: "Bearer prism_dev_routepolicycanaryroutepolicycanary",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel"
        }
      }),
      { params: Promise.resolve({ method: "chat.postMessage" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBe(body.prism.requestId);
    expect(response.headers.get("x-prism-upstream-called")).toBe("false");
    expect(body).toMatchObject({
      ok: false,
      error: "not_allowed",
      prism: { errorClass: "capability_denied", method: "chat.postMessage", requiredCapability: "writeMessages", tokenProfileId: "profile_1" }
    });
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary|xox[bp]-|refresh|access_token|client_secret/i);
  });

  it("returns unsupported errors for admin/deferred methods and an explicit not-forwarding response for allowed methods", async () => {
    const { GET } = await import("./route");
    const admin = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/admin.users.list", {
        headers: { authorization: "Bearer prism_dev_adminpolicycanaryadminpolicycanary" }
      }),
      { params: Promise.resolve({ method: "admin.users.list" }) }
    );
    const allowed = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/conversations.history", {
        headers: {
          authorization: "Bearer prism_dev_allowedpolicycanaryallowedpolicy",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel"
        }
      }),
      { params: Promise.resolve({ method: "conversations.history" }) }
    );

    expect(await admin.json()).toMatchObject({ ok: false, error: "method_not_supported", prism: { errorClass: "unsupported_method", category: "admin" } });
    expect(admin.headers.get("x-prism-upstream-called")).toBe("false");
    expect(allowed.headers.get("x-prism-policy-decision")).toBe("allowed");
    expect(allowed.headers.get("x-prism-execution-mode")).toBe("user");
    expect(allowed.headers.get("x-prism-upstream-called")).toBe("false");
    expect(await allowed.json()).toMatchObject({
      ok: false,
      error: "slack_forwarding_not_implemented",
      prism: { method: "conversations.history", category: "conversations.read", policy: "allowed" }
    });
  });

  it("honors selectable execution-mode headers after policy and denies invalid or non-selectable overrides before forwarding", async () => {
    const { GET } = await import("./route");
    mockDb.query.mockResolvedValueOnce({ rows: [row({ ...capabilityMap({ writeMessages: true }), executionIdentity: "selectable" })], rowCount: 1 });
    const selectableBot = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        headers: {
          authorization: "Bearer prism_dev_selectableroutecanaryselectableok",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel",
          "x-prism-execution-mode": "bot"
        }
      }),
      { params: Promise.resolve({ method: "chat.postMessage" }) }
    );
    const selectableBody = await selectableBot.json();

    mockDb.query.mockResolvedValueOnce({ rows: [row({ ...capabilityMap(), executionIdentity: "selectable" })], rowCount: 1 });
    const invalidMode = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/conversations.history", {
        headers: {
          authorization: "Bearer prism_dev_invalidmodecanaryinvalidmodeokxx",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel",
          "x-prism-execution-mode": "admin"
        }
      }),
      { params: Promise.resolve({ method: "conversations.history" }) }
    );

    const nonSelectable = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/conversations.history", {
        headers: {
          authorization: "Bearer prism_dev_nonselectableroutecanarynonselectok",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel",
          "x-prism-execution-mode": "bot"
        }
      }),
      { params: Promise.resolve({ method: "conversations.history" }) }
    );

    expect(selectableBot.status).toBe(501);
    expect(selectableBot.headers.get("x-prism-policy-decision")).toBe("allowed");
    expect(selectableBot.headers.get("x-prism-execution-mode")).toBe("bot");
    expect(selectableBot.headers.get("x-prism-upstream-called")).toBe("false");
    expect(selectableBody).toMatchObject({ ok: false, error: "slack_forwarding_not_implemented" });
    expect(await invalidMode.json()).toMatchObject({ ok: false, error: "not_allowed", prism: { errorClass: "invalid_execution_mode" } });
    expect(await nonSelectable.json()).toMatchObject({ ok: false, error: "not_allowed", prism: { errorClass: "execution_mode_not_selectable" } });
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
  });

  it("rejects malformed bearer tokens before querying token or Slack credential metadata", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/slack/api/conversations.history", {
        method: "POST",
        headers: { authorization: "Bearer not-a-prism-token" }
      }),
      { params: Promise.resolve({ method: "conversations.history" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: "invalid_auth", prism: { errorClass: "invalid_auth", method: "conversations.history" } });
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
