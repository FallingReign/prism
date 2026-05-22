import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn<(callback: (db: typeof mockDb) => Promise<unknown>) => Promise<unknown>>()
}));

vi.mock("../../../../src/server/db", () => ({ database: mockDb }));

describe("/v1/prism/token-profiles", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (callback) => callback(mockDb));
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER = "pepper-secret-canary";
    process.env.PRISM_DEVELOPER_TOKEN_PEPPER_ID = "test-pepper";
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from prism_sessions")) {
        return { rows: [{ prism_user_id: "user_1", slack_connection_id: "conn_1", status: "healthy" }], rowCount: 1 };
      }
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
              capability_map: {
                version: 1,
                preset: "read_only",
                actions: { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false },
                executionIdentity: "automatic"
              },
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
              preset: "read_only",
              capability_map: { version: 1, actions: { read: true, search: true, destructive: false } },
              expires_at: null,
              status: "active",
              created_at: new Date("2026-01-01T00:00:00.000Z"),
              updated_at: new Date("2026-01-01T00:00:00.000Z")
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
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain(body.developerToken);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain("pepper-secret-canary");
  });

  it("lists Token profile metadata without making developer tokens retrievable", async () => {
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost:3732/v1/prism/token-profiles", { headers: { cookie: "prism_session=session-token" } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(body)).toContain("Local MCP read");
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary/i);
  });
});
