import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { getOwnerSlackCatalog } from "./slack-catalog";

describe("remote Codex Slack catalog ownership", () => {
  it("resolves an exact Slack team and actor to only their paired installation sessions", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("c.id = i.slack_connection_id");
      expect(sql).toContain("c.team_id = $1");
      expect(sql).toContain("c.authed_user_id = $2");
      expect(sql).toContain("c.app_id = $3");
      expect(sql).toContain("slack_connection_workspace_grants");
      expect(sql).not.toMatch(/\bcwd\b|preview|prompt|output|transcript/i);
      expect(params).toEqual(["T123", "U123", "A123", 10]);
      return {
        rows: [
          {
            publisher_connection_id: "connection-owner",
            publisher_prism_user_id: "owner_1",
            installation_id: "rc_install_1",
            machine_label: "Workstation",
            codex_thread_id: "thread_1",
            safe_title: "Ship companion",
            project_label: "remote-codex",
            status: "ready",
            last_activity_at: new Date("2026-08-31T08:00:00.000Z")
          }
        ],
        rowCount: 1
      };
    });

    await expect(getOwnerSlackCatalog(fakeDatabase(query), { teamId: "T123", slackUserId: "U123", appId: "A123", limit: 10 })).resolves.toEqual({
      connectionId: "connection-owner",
      sessions: [
        {
          installationId: "rc_install_1",
          threadId: "thread_1",
          title: "Ship companion",
          projectLabel: "remote-codex",
          status: "ready",
          lastActivity: "2026-08-31T08:00:00.000Z",
          machineLabel: "Workstation"
        }
      ]
    });
  });

  it("keeps the exact owner connection available before their first session sync", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        publisher_connection_id: "connection-owner", publisher_prism_user_id: "owner_1", installation_id: null,
        machine_label: null, codex_thread_id: null, safe_title: null, project_label: null,
        status: null, last_activity_at: null
      }],
      rowCount: 1
    }));
    await expect(getOwnerSlackCatalog(fakeDatabase(query), { teamId: "T123", slackUserId: "U123", appId: "A123" })).resolves.toEqual({
      connectionId: "connection-owner",
      sessions: []
    });
  });
});

function fakeDatabase(query: ReturnType<typeof vi.fn>): Database {
  const value: Database = { query: query as unknown as Database["query"], transaction: async (callback) => callback(value) };
  return value;
}
