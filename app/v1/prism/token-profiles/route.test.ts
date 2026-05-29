import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { buildCurrentGlobalTokenProfilePolicy } from "../../../../src/server/token-profiles/global-policy";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn<(callback: (db: typeof mockDb) => Promise<unknown>) => Promise<unknown>>()
}));

vi.mock("../../../../src/server/db", () => ({ database: mockDb }));

let failAuditInsert = false;
let persistedPreset: "read_only" | "messages_only" = "read_only";
let persistedCapabilityMap: Record<string, unknown> = capabilityMapFor("read_only");
let persistedExpiresAt: Date | null = null;
let persistedProfileStatus: "active" | "revoked" = "active";
let persistedDeveloperTokenRevokedAt: Date | null = null;
let persistedGlobalPolicy: ReturnType<typeof buildCurrentGlobalTokenProfilePolicy> = buildCurrentGlobalTokenProfilePolicy();

describe("/v1/prism/token-profiles", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (callback) => callback(mockDb));
    failAuditInsert = false;
    persistedPreset = "read_only";
    persistedCapabilityMap = capabilityMapFor("read_only");
    persistedExpiresAt = null;
    persistedProfileStatus = "active";
    persistedDeveloperTokenRevokedAt = null;
    persistedGlobalPolicy = buildCurrentGlobalTokenProfilePolicy();
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER = "pepper-secret-canary";
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER_ID = "test-pepper";
    mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from prism_sessions")) {
        return { rows: [{ prism_user_id: "user_1", slack_connection_id: "conn_1", status: "healthy" }], rowCount: 1 };
      }
      if (sql.includes("from prism_settings")) return { rows: [settingRow(persistedGlobalPolicy)], rowCount: 1 };
      if (sql.includes("select 1 from token_profiles")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into token_profiles")) {
        return {
          rows: [
            {
              id: "profile_1",
              prism_user_id: "user_1",
              slack_connection_id: "conn_1",
              name: "Local MCP read",
              name_normalized: "local mcp read",
              intended_use: "Read Slack context locally",
              preset: "read_only",
              capability_map: capabilityMapFor("read_only"),
              expires_at: null,
              status: "active",
              created_at: new Date("2026-01-01T00:00:00.000Z"),
              updated_at: new Date("2026-01-01T00:00:00.000Z")
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes("insert into prism_developer_tokens")) return { rows: [], rowCount: 1 };
      if (sql.includes("update token_profiles") && sql.includes("set status = 'revoked'")) {
        persistedProfileStatus = "revoked";
        persistedDeveloperTokenRevokedAt = params?.[1] as Date;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update token_profiles")) {
        persistedPreset = params?.[1] as typeof persistedPreset;
        persistedCapabilityMap = JSON.parse(String(params?.[2]));
        persistedExpiresAt = (params?.[3] as Date | null) ?? null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update prism_developer_tokens")) {
        if (sql.includes("revoked_at")) persistedDeveloperTokenRevokedAt = (params?.[1] as Date | null) ?? persistedDeveloperTokenRevokedAt;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("delete from token_profiles")) {
        if (persistedProfileStatus === "active" && !persistedDeveloperTokenRevokedAt) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into prism_activity_audit")) {
        if (failAuditInsert) throw new Error("audit unavailable");
        return { rows: [activityRowFromInsertParams(params)], rowCount: 1 };
      }
      if (sql.includes("from token_profiles")) {
        return {
          rows: [
            {
              id: "profile_1",
              prism_user_id: "user_1",
              slack_connection_id: "conn_1",
              name: "Local MCP read",
              name_normalized: "local mcp read",
              intended_use: "Read Slack context locally",
              preset: persistedPreset,
              capability_map: persistedCapabilityMap,
              expires_at: persistedExpiresAt,
              status: persistedProfileStatus,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
              updated_at: new Date("2026-01-01T00:00:00.000Z"),
              developer_token_created_at: new Date("2026-01-01T00:00:00.000Z"),
              developer_token_expires_at: persistedExpiresAt,
              developer_token_last_used_at: null,
              developer_token_revoked_at: persistedDeveloperTokenRevokedAt,
              developer_token_is_current: !persistedDeveloperTokenRevokedAt,
              overlap_expires_at: null
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });
  });

  it("creates a copy-once developer token for a Slack-linked website session", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/prism/token-profiles", {
        method: "POST",
        headers: { cookie: "prism_session=session-token", "content-type": "application/json" },
        body: JSON.stringify({
          name: "Local MCP read",
          intendedUse: "Read Slack context locally",
          preset: "read_only",
          executionIdentity: "automatic"
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.developerToken).toMatch(/^prism_dev_/);
    expect(body.profile).toMatchObject({ name: "Local MCP read", preset: "read_only" });
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("insert into prism_activity_audit"))).toBe(true);
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain(body.developerToken);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain("pepper-secret-canary");
  });

  it("does not return a copy-once developer token when creation audit cannot be recorded", async () => {
    failAuditInsert = true;
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/prism/token-profiles", {
        method: "POST",
        headers: { cookie: "prism_session=session-token", "content-type": "application/json" },
        body: JSON.stringify({
          name: "Local MCP read",
          intendedUse: "Read Slack context locally",
          preset: "read_only",
          executionIdentity: "automatic"
        })
      })
    );
    const body = await response.json();

    expect(mockDb.transaction).toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ error: "audit_unavailable" });
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary/i);
  });

  it("rejects Token profile creation when the Global Token profile policy disallows the request", async () => {
    persistedGlobalPolicy = buildCurrentGlobalTokenProfilePolicy({ presets: { allowed: ["read_only"], default: "read_only" } });
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/prism/token-profiles", {
        method: "POST",
        headers: { cookie: "prism_session=session-token", "content-type": "application/json" },
        body: JSON.stringify({
          name: "Message writer",
          intendedUse: "Post approved messages",
          preset: "messages_only",
          executionIdentity: "automatic"
        })
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ error: "global_policy_violation", reasons: [{ code: "preset_disallowed" }] });
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary|xox[bp]-|access_token|refresh_token/i);
  });

  it("lists Token profile metadata without making developer tokens retrievable", async () => {
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost:3732/v1/prism/token-profiles", { headers: { cookie: "prism_session=session-token" } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("insert into prism_activity_audit"))).toBe(true);
    expect(JSON.stringify(body)).toContain("Local MCP read");
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary/i);
  });

  it("revokes a Token profile developer token through the website session without returning token material", async () => {
    const { POST } = await import("./[profileId]/revoke/route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/prism/token-profiles/profile_1/revoke", {
        method: "POST",
        headers: { cookie: "prism_session=session-token" }
      }),
      { params: Promise.resolve({ profileId: "profile_1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body).toMatchObject({ profile: { id: "profile_1", developerToken: { status: "revoked" } }, slackStatus: "healthy" });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("update prism_developer_tokens"))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary/i);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
  });

  it("rejects permanent deletion while a Token profile still has active access", async () => {
    const { DELETE } = await import("./[profileId]/route");
    const response = await DELETE(
      new NextRequest("http://localhost:3732/v1/prism/token-profiles/profile_1", {
        method: "DELETE",
        headers: { cookie: "prism_session=session-token" }
      }),
      { params: Promise.resolve({ profileId: "profile_1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body).toEqual({ error: "active_profile_requires_revoke" });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("delete from token_profiles"))).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary/i);
  });

  it("permanently deletes an inactive Token profile without returning token material", async () => {
    persistedProfileStatus = "revoked";
    persistedDeveloperTokenRevokedAt = new Date("2026-01-01T00:00:00.000Z");
    const { DELETE } = await import("./[profileId]/route");
    const response = await DELETE(
      new NextRequest("http://localhost:3732/v1/prism/token-profiles/profile_1", {
        method: "DELETE",
        headers: { cookie: "prism_session=session-token" }
      }),
      { params: Promise.resolve({ profileId: "profile_1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body).toMatchObject({ profile: { id: "profile_1", status: "revoked" }, slackStatus: "healthy" });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("delete from token_profiles"))).toBe(true);
    expect(mockDb.query.mock.calls.some(([, params]) => Array.isArray(params) && params.includes("token_profile_deleted") && params.includes("deleted"))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary/i);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
  });

  it("rotates a Token profile developer token and returns the replacement once", async () => {
    const { POST } = await import("./[profileId]/rotate/route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/prism/token-profiles/profile_1/rotate", {
        method: "POST",
        headers: { cookie: "prism_session=session-token", "content-type": "application/json" },
        body: JSON.stringify({ overlap: "none" })
      }),
      { params: Promise.resolve({ profileId: "profile_1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body.developerToken).toMatch(/^prism_dev_/);
    expect(body.profile).toMatchObject({ id: "profile_1", developerToken: { status: "active" } });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("insert into prism_developer_tokens"))).toBe(true);
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("update prism_developer_tokens"))).toBe(true);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain(body.developerToken);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/pepper-secret-canary|access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
  });

  it("requires confirmation for policy broadening and returns a rotated replacement once when confirmed", async () => {
    const { POST } = await import("./[profileId]/policy/route");
    const broadeningInput = {
      name: "Local MCP read",
      intendedUse: "Read Slack context locally",
      preset: "messages_only",
      executionIdentity: "automatic"
    };

    const blocked = await POST(
      new NextRequest("http://localhost:3732/v1/prism/token-profiles/profile_1/policy", {
        method: "POST",
        headers: { cookie: "prism_session=session-token", "content-type": "application/json" },
        body: JSON.stringify(broadeningInput)
      }),
      { params: Promise.resolve({ profileId: "profile_1" }) }
    );
    const blockedBody = await blocked.json();

    expect(blocked.status).toBe(409);
    expect(blockedBody).toMatchObject({ error: "rotation_required" });
    expect(JSON.stringify(blockedBody)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary/i);

    const confirmed = await POST(
      new NextRequest("http://localhost:3732/v1/prism/token-profiles/profile_1/policy", {
        method: "POST",
        headers: { cookie: "prism_session=session-token", "content-type": "application/json" },
        body: JSON.stringify({ ...broadeningInput, confirmBroadening: true })
      }),
      { params: Promise.resolve({ profileId: "profile_1" }) }
    );
    const confirmedBody = await confirmed.json();

    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("cache-control")).toBe("no-store");
    expect(confirmedBody).toMatchObject({ change: "broadening", profile: { id: "profile_1", preset: "messages_only" }, slackStatus: "healthy" });
    expect(confirmedBody.developerToken).toMatch(/^prism_dev_/);
    expect(mockDb.query.mock.calls.some(([, params]) => Array.isArray(params) && params.includes("token_profile_policy_updated"))).toBe(true);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain(confirmedBody.developerToken);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/pepper-secret-canary|access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret/i);
  });
});

function activityRowFromInsertParams(params: unknown[] = []) {
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

function settingRow(policy: unknown, version = 1) {
  return {
    value: policy,
    version,
    updated_by_prism_user_id: null,
    updated_at: new Date("2026-01-01T00:00:00.000Z")
  };
}

function capabilityMapFor(preset: "read_only" | "messages_only") {
  const messagesOnly = preset === "messages_only";
  return {
    version: 1,
    preset,
    workspaces: { mode: "linked_slack_connection" },
    surfaces: {
      publicChannels: true,
      privateChannels: true,
      directMessages: true,
      groupDirectMessages: true,
      search: !messagesOnly,
      filesMetadata: false,
      canvases: false,
      lists: false,
      future: false
    },
    actions: { read: true, search: !messagesOnly, writeMessages: messagesOnly, reactions: messagesOnly, filesMetadata: false, destructive: false },
    executionIdentity: "automatic",
    experiment: { enabled: false, ttl: null },
    mutation: { destructiveOptIn: false, narrowingAppliesImmediately: true, broadeningRequiresRotation: true },
    deferred: { admin: false, fileTransfer: false, events: false, slashCommands: false, interactivity: false, canvases: false, lists: false }
  };
}
