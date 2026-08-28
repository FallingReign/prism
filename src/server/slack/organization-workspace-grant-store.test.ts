import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { replaceOrganizationWorkspaceGrants } from "./organization-workspace-grant-store";

describe("organization workspace grant persistence", () => {
  it("replaces a complete discovered set atomically and retains revoked rows for audit", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("for update")) return { rows: [{ id: "conn_org" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const database = fakeDatabase(query);
    const verifiedAt = new Date("2026-08-28T00:00:00.000Z");

    await replaceOrganizationWorkspaceGrants(database, {
      connectionId: "conn_org",
      teams: [{ teamId: "T111", teamName: "One" }, { teamId: "T222", teamName: "Two" }],
      verifiedAt
    });

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[1]?.[0]).toContain("source = 'auth_teams_list'");
    expect(query.mock.calls[3]?.[0]).toContain("set status = 'revoked'");
    expect(query.mock.calls[3]?.[1]).toEqual(["conn_org", verifiedAt, ["T111", "T222"]]);
  });

  it("fails closed when the target is not a healthy organization connection", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(replaceOrganizationWorkspaceGrants(fakeDatabase(query), {
      connectionId: "conn_workspace", teams: [], verifiedAt: new Date()
    })).rejects.toThrow("organization-connection-unavailable");
    expect(query).toHaveBeenCalledTimes(1);
  });
});

function fakeDatabase(query: unknown): Database {
  const database: Database = {
    query: query as Database["query"],
    transaction: async (callback) => callback(database)
  };
  return database;
}
