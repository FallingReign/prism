import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn<(callback: (db: typeof mockDb) => Promise<unknown>) => Promise<unknown>>()
}));

vi.mock("../../../../src/server/db", () => ({ database: mockDb }));

describe("DELETE /v1/prism/slack-connection", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (callback) => callback(mockDb));
    mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from prism_sessions s") && sql.includes("join slack_connections c")) {
        return {
          rows: [
            {
              id: "conn_1",
              prism_user_id: "user_1",
              authed_user_id: "U123",
              team_id: "T123",
              enterprise_id: null
            }
          ],
          rowCount: 1
        };
      }
      if (sql.includes("insert into prism_activity_audit")) return { rows: [activityRowFromInsertParams(params)], rowCount: 1 };
      if (sql.includes("delete from slack_connections")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });

  it("removes the current local Slack connection without returning secret material", async () => {
    const { DELETE } = await import("./route");
    const response = await DELETE(
      new NextRequest("http://localhost:3732/v1/prism/slack-connection", {
        method: "DELETE",
        headers: { cookie: "prism_session=session-token" }
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(body).toEqual({ status: "removed" });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("delete from slack_connections"))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/prism_dev_|tokenHash|pepper|access_token|refresh_token|xox[bp]-|client_secret|authorization/i);
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret|prism_dev_|tokenHash|pepper/i);
  });

  it("rejects missing website sessions without attempting deletion", async () => {
    const { DELETE } = await import("./route");
    const response = await DELETE(new NextRequest("http://localhost:3732/v1/prism/slack-connection", { method: "DELETE" }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: "unauthenticated" });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes("delete from slack_connections"))).toBe(false);
  });
});

function activityRowFromInsertParams(params: unknown[] | undefined) {
  if (!params) throw new Error("expected activity params");
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
