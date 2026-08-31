import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { createPostgresBindingStore } from "./binding-postgres-store";
import type { OwnedRemoteCodexSession } from "./binding-service";

describe("Remote Codex binding reservation recovery", () => {
  it("expires a stale creating reservation before reserving the same session", async () => {
    const now = new Date("2026-08-31T08:00:00.000Z");
    let bindingReads = 0;
    let insertedId = "";
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("state = 'failed'") && sql.includes("updated_at <")) {
        expect(params).toEqual(["rc_install_1", "thread_1", now, new Date("2026-08-31T07:58:00.000Z")]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("from remote_codex_slack_bindings")) {
        bindingReads += 1;
        return bindingReads === 1
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: insertedId, installation_id: "rc_install_1", codex_thread_id: "thread_1", team_id: "T123", channel_id: null, thread_ts: null, state: "creating" }], rowCount: 1 };
      }
      if (sql.includes("insert into remote_codex_slack_bindings")) {
        insertedId = String(params?.[0]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await createPostgresBindingStore(fakeDatabase(query)).reserve(session, now);
    expect(result.created).toBe(true);
    expect(query.mock.calls[0]?.[0]).toContain("state = 'failed'");
  });
});

const session: OwnedRemoteCodexSession = {
  installationId: "rc_install_1", threadId: "thread_1", title: "Ship companion",
  projectLabel: "remote-codex", machineLabel: "Workstation", status: "ready",
  prismUserId: "owner_1", connectionId: "connection-owner", teamId: "T123", slackUserId: "U123"
};
function fakeDatabase(query: ReturnType<typeof vi.fn>): Database {
  const value: Database = { query: query as unknown as Database["query"], transaction: async (callback) => callback(value) };
  return value;
}
