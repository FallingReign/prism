import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { hashSecret } from "./oauth-flow";
import { getSlackLinkStatus } from "./postgres-store";

describe("Postgres Slack website status", () => {
  it("returns friendly workspace and organization names from the session-scoped connection", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("from prism_sessions");
      expect(sql).toContain("team_name");
      expect(sql).toContain("enterprise_name");
      expect(params).toEqual([hashSecret("session-token")]);
      return {
        rows: [
          {
            status: "healthy",
            team_id: "T123",
            team_name: "Example Workspace",
            enterprise_id: "E123",
            enterprise_name: "Example Enterprise",
            authed_user_id: "U123",
            last_error_class: null
          }
        ],
        rowCount: 1
      };
    });

    await expect(getSlackLinkStatus(fakeDatabase(query), "session-token")).resolves.toEqual({
      kind: "linked",
      status: "healthy",
      teamId: "T123",
      teamName: "Example Workspace",
      enterpriseId: "E123",
      enterpriseName: "Example Enterprise",
      slackUserId: "U123",
      lastErrorClass: null
    });
  });
});

function fakeDatabase(query: Database["query"]): Database {
  return { query };
}
