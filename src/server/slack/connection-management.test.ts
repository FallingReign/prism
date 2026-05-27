import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { hashSecret } from "./oauth-flow";
import { createPostgresSlackConnectionManagementStore, removeSlackConnection, type SlackConnectionManagementStore } from "./connection-management";

const now = new Date("2026-01-01T00:00:00.000Z");

describe("Slack connection management", () => {
  it("removes the current session Slack connection without exposing credential material", async () => {
    const removed: string[] = [];
    const store: SlackConnectionManagementStore = {
      async removeCurrentConnection(input) {
        expect(input).toEqual({
          sessionToken: "session-token",
          audit: { endpoint: "/v1/prism/slack-connection", requestId: "req_remove" },
          now
        });
        removed.push("conn_1");
        return { kind: "removed", connectionId: "conn_1" };
      }
    };

    await expect(
      removeSlackConnection({
        store,
        sessionToken: "session-token",
        audit: { endpoint: "/v1/prism/slack-connection", requestId: "req_remove" },
        now
      })
    ).resolves.toEqual({ kind: "removed", connectionId: "conn_1" });
    expect(removed).toEqual(["conn_1"]);
  });

  it("does not call the store when the browser session cookie is missing", async () => {
    const store: SlackConnectionManagementStore = {
      removeCurrentConnection: vi.fn()
    };

    await expect(removeSlackConnection({ store, sessionToken: undefined, now })).resolves.toEqual({ kind: "unauthenticated" });
    expect(store.removeCurrentConnection).not.toHaveBeenCalled();
  });

  it("deletes only the Slack connection resolved from the current non-expired session and records metadata-only audit", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).not.toMatch(/access_token_envelope|refresh_token_envelope|xox[bp]-|client_secret|prism_dev_|tokenHash|pepper/i);
      if (sql.includes("from prism_sessions s") && sql.includes("join slack_connections c")) {
        expect(params).toEqual([hashSecret("session-token"), now]);
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
      if (sql.includes("insert into prism_activity_audit")) {
        expect(params?.[1]).toBe("user_1");
        expect(params?.[2]).toBe("conn_1");
        expect(params?.[5]).toBe("U123");
        expect(params?.[6]).toBe("T123");
        expect(params?.[8]).toBe("slack_connection_removed");
        expect(params?.[16]).toBe("deleted");
        return { rows: [activityRowFromInsertParams(params)], rowCount: 1 };
      }
      if (sql.includes("delete from slack_connections")) {
        expect(params).toEqual(["conn_1", "user_1"]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await createPostgresSlackConnectionManagementStore(fakeDatabase(query)).removeCurrentConnection({
      sessionToken: "session-token",
      audit: { endpoint: "/v1/prism/slack-connection", requestId: "req_remove" },
      now
    });

    expect(result).toEqual({ kind: "removed", connectionId: "conn_1" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("delete from slack_connections"))).toBe(true);
  });
});

function fakeDatabase(query: Database["query"]): Database {
  return {
    query,
    async transaction(callback) {
      return callback(this);
    }
  };
}

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
