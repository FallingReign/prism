import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>()
}));

vi.mock("../../../../../src/server/db", () => ({ database: mockDb }));

let defaultTokenRows: unknown[] = [];
let queuedTokenRows: unknown[][] = [];

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

function row(map = capabilityMap(), overrides: Record<string, unknown> = {}) {
  return {
    developer_token_id: "devtoken_1",
    prism_user_id: "user_1",
    token_profile_id: "profile_1",
    token_profile_name: "Local MCP",
    slack_connection_id: "conn_1",
    token_expires_at: null,
    token_revoked_at: null,
    token_last_used_at: null,
    token_overlap_expires_at: null,
    token_is_current: true,
    profile_status: "active",
    profile_expires_at: null,
    preset: map.preset,
    capability_map: map,
    slack_status: "healthy",
    slack_team_id: "T123",
    slack_enterprise_id: null,
    slack_user_id: "U123",
    slack_last_error_class: null,
    has_user_credential: true,
    has_bot_credential: true,
    ...overrides
  };
}

describe("/v1/slack/api/[method] policy tracer", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER = "pepper-secret-canary";
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER_ID = "test-pepper";
    defaultTokenRows = [row()];
    queuedTokenRows = [];
    mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("insert into prism_activity_audit")) {
        return { rows: [activityRowFromInsertParams(params ?? [])], rowCount: 1 };
      }
      if (sql.includes("update prism_activity_audit")) {
        return { rows: [activityRowFromUpdateParams(params ?? [])], rowCount: 1 };
      }
      const rows = queuedTokenRows.shift() ?? defaultTokenRows;
      return { rows, rowCount: rows.length };
    });
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

  it("returns unsupported errors without upstream calls and forwards allowed methods through the default mock upstream", async () => {
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
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("x-prism-upstream-called")).toBe("true");
    expect(await allowed.json()).toMatchObject({
      ok: true,
      messages: [{ type: "message", channel: "C-MOCK-GENERAL" }],
      response_metadata: { next_cursor: "mock-next-cursor" }
    });
  });

  it("honors selectable execution-mode headers after policy and denies invalid or non-selectable overrides before forwarding", async () => {
    const { GET } = await import("./route");
    queueTokenRows([row({ ...capabilityMap({ writeMessages: true }), executionIdentity: "selectable" })]);
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

    queueTokenRows([row({ ...capabilityMap(), executionIdentity: "selectable" })]);
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

    expect(selectableBot.status).toBe(200);
    expect(selectableBot.headers.get("x-prism-policy-decision")).toBe("allowed");
    expect(selectableBot.headers.get("x-prism-execution-mode")).toBe("bot");
    expect(selectableBot.headers.get("x-prism-upstream-called")).toBe("true");
    expect(selectableBody).toMatchObject({ ok: true, channel: "C-MOCK-GENERAL", message: { user: "B-MOCK" } });
    expect(await invalidMode.json()).toMatchObject({ ok: false, error: "not_allowed", prism: { errorClass: "invalid_execution_mode" } });
    expect(await nonSelectable.json()).toMatchObject({ ok: false, error: "not_allowed", prism: { errorClass: "execution_mode_not_selectable" } });
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
  });

  it("forwards representative conversations, messages, reactions, search, and file metadata methods with Slack-shaped bodies", async () => {
    const { GET, POST } = await import("./route");
    const fullBridge = capabilityMap({ writeMessages: true, reactions: true, filesMetadata: true });
    defaultTokenRows = [row(fullBridge)];

    const conversations = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/conversations.list?cursor=abc&limit=2", {
        headers: {
          authorization: "Bearer prism_dev_conversationsforwardingcanaryokxx",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel"
        }
      }),
      { params: Promise.resolve({ method: "conversations.list" }) }
    );
    const message = await POST(
      new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: "Bearer prism_dev_messageforwardingcanarymessageokxx",
          "content-type": "application/json",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel"
        },
        body: JSON.stringify({ channel: "C-MOCK-GENERAL", text: "hello from local tool", token: "local-tool-token-must-not-forward" })
      }),
      { params: Promise.resolve({ method: "chat.postMessage" }) }
    );
    const reaction = await POST(
      new NextRequest("http://localhost:3732/v1/slack/api/reactions.add", {
        method: "POST",
        headers: {
          authorization: "Bearer prism_dev_reactionforwardingcanaryreactionokxx",
          "content-type": "application/x-www-form-urlencoded",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel"
        },
        body: new URLSearchParams({ channel: "C-MOCK-GENERAL", timestamp: "1700000001.000200", name: "thumbsup" })
      }),
      { params: Promise.resolve({ method: "reactions.add" }) }
    );
    const search = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/search.messages?query=mock", {
        headers: { authorization: "Bearer prism_dev_searchforwardingcanarysearchokxx", "x-prism-workspace-id": "T123" }
      }),
      { params: Promise.resolve({ method: "search.messages" }) }
    );
    const fileInfo = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/files.info?file=F123", {
        headers: { authorization: "Bearer prism_dev_fileforwardingcanaryfilecanaryokxx", "x-prism-workspace-id": "T123" }
      }),
      { params: Promise.resolve({ method: "files.info" }) }
    );

    expect(conversations.headers.get("x-prism-upstream-called")).toBe("true");
    expect(await conversations.json()).toMatchObject({ ok: true, channels: [{ id: "C-MOCK-GENERAL" }], response_metadata: { next_cursor: "mock-next-cursor" } });
    expect(await message.json()).toMatchObject({ ok: true, channel: "C-MOCK-GENERAL", message: { text: "hello from local tool" } });
    expect(await reaction.json()).toEqual({ ok: true });
    expect(await search.json()).toMatchObject({ ok: true, query: "mock", messages: { matches: [{ channel: { id: "C-MOCK-GENERAL" } }] } });
    expect(await fileInfo.json()).toMatchObject({ ok: true, file: { id: "F123", name: "mock.txt" } });
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
  });

  it("passes ordinary upstream Slack errors through without Prism body wrapping", async () => {
    const { POST } = await import("./route");
    defaultTokenRows = [row(capabilityMap({ writeMessages: true }))];

    const response = await POST(
      new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: "Bearer prism_dev_upstreamerrorcanaryupstreamerror",
          "content-type": "application/json",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel"
        },
        body: JSON.stringify({ channel: "C-MOCK-ERROR", text: "will fail upstream" })
      }),
      { params: Promise.resolve({ method: "chat.postMessage" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-prism-upstream-called")).toBe("true");
    expect(body).toEqual({ ok: false, error: "channel_not_found" });
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

  it("rejects revoked, expired overlap, and Slack reauth-gated tokens before upstream forwarding", async () => {
    const { GET } = await import("./route");
    queueTokenRows([row(capabilityMap({ writeMessages: true }), { token_revoked_at: new Date("2026-01-01T00:00:00.000Z") })]);
    const revoked = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        headers: {
          authorization: "Bearer prism_dev_revokedslackroutecanaryrevokedok",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel"
        }
      }),
      { params: Promise.resolve({ method: "chat.postMessage" }) }
    );

    queueTokenRows([
      row(capabilityMap({ writeMessages: true }), {
        token_expires_at: new Date("2025-12-31T23:45:00.000Z"),
        token_overlap_expires_at: new Date("2025-12-31T23:45:00.000Z"),
        token_is_current: false
      })
    ]);
    const expiredOverlap = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        headers: {
          authorization: "Bearer prism_dev_expiredslackroutecanaryexpiredok",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel"
        }
      }),
      { params: Promise.resolve({ method: "chat.postMessage" }) }
    );

    queueTokenRows([row(capabilityMap({ writeMessages: true }), { slack_status: "reauth_required", slack_last_error_class: "invalid_refresh_token" })]);
    const reauth = await GET(
      new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        headers: {
          authorization: "Bearer prism_dev_reauthslackroutecanaryreauthokxx",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel"
        }
      }),
      { params: Promise.resolve({ method: "chat.postMessage" }) }
    );

    expect(revoked.headers.get("x-prism-upstream-called")).toBe("false");
    expect(await revoked.json()).toMatchObject({ ok: false, error: "token_revoked", prism: { errorClass: "token_revoked" } });
    expect(expiredOverlap.headers.get("x-prism-upstream-called")).toBe("false");
    expect(await expiredOverlap.json()).toMatchObject({ ok: false, error: "token_expired", prism: { errorClass: "token_expired" } });
    expect(reauth.headers.get("x-prism-upstream-called")).toBe("false");
    expect(await reauth.json()).toMatchObject({
      ok: false,
      error: "not_allowed",
      prism: { errorClass: "execution_identity_unavailable", unavailableReason: "slack_reauth_required" }
    });
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
  });

  it("records Slack method audit rows with metadata only", async () => {
    const { POST } = await import("./route");
    defaultTokenRows = [row(capabilityMap({ writeMessages: true }))];

    const response = await POST(
      new NextRequest("http://localhost:3732/v1/slack/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: "Bearer prism_dev_auditroutecanaryauditroutecanary",
          "content-type": "application/json",
          "x-prism-workspace-id": "T123",
          "x-prism-surface": "public_channel"
        },
        body: JSON.stringify({
          channel: "C123",
          text: "MESSAGE_TEXT_CANARY",
          blocks: [{ text: "BLOCK_KIT_CANARY" }],
          token: "local-tool-token-must-not-audit"
        })
      }),
      { params: Promise.resolve({ method: "chat.postMessage" }) }
    );

    expect(await response.json()).toMatchObject({ ok: true });
    expect(mockDb.query.mock.calls.filter(([sql]) => String(sql).includes("insert into prism_activity_audit"))).toHaveLength(1);
    expect(mockDb.query.mock.calls.filter(([sql]) => String(sql).includes("update prism_activity_audit"))).toHaveLength(1);
    expect(JSON.stringify(mockDb.query.mock.calls)).toContain("C123");
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/MESSAGE_TEXT_CANARY|BLOCK_KIT_CANARY|local-tool-token-must-not-audit|prism_dev_|pepper-secret-canary|xox[bp]-|client_secret/i);
  });
});

function queueTokenRows(rows: unknown[]) {
  queuedTokenRows.push(rows);
}

function activityRowFromInsertParams(params: unknown[]) {
  return {
    id: params[0],
    prism_user_id: params[1],
    slack_connection_id: params[2],
    token_profile_id: params[3],
    token_profile_name: params[4],
    slack_user_id: params[5],
    slack_team_id: params[6],
    slack_enterprise_id: params[7],
    activity_type: params[8],
    endpoint: params[9],
    slack_method: params[10],
    action_category: params[11],
    surface: params[12],
    object_type: params[13],
    object_id: params[14],
    execution_mode: params[15],
    status: params[16],
    error_class: params[17],
    http_status: params[18],
    request_id: params[19],
    upstream_called: params[20],
    occurred_at: params[21],
    retention_expires_at: params[22]
  };
}

function activityRowFromUpdateParams(params: unknown[]) {
  return {
    id: params[0],
    prism_user_id: "user_1",
    slack_connection_id: "conn_1",
    token_profile_id: "profile_1",
    token_profile_name: "Local MCP",
    slack_user_id: "U123",
    slack_team_id: "T123",
    slack_enterprise_id: null,
    activity_type: "slack_method",
    endpoint: "/v1/slack/api/chat.postMessage",
    slack_method: "chat.postMessage",
    action_category: "messages.write",
    surface: "public_channel",
    object_type: "channel",
    object_id: "C-MOCK-GENERAL",
    execution_mode: "bot",
    status: params[1],
    error_class: params[2],
    http_status: params[3],
    request_id: "req_1",
    upstream_called: params[4],
    occurred_at: new Date("2026-01-01T00:00:00.000Z"),
    retention_expires_at: new Date("2026-04-01T00:00:00.000Z")
  };
}
