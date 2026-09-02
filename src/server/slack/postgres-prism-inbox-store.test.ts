import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { createPostgresPrismInboxStore } from "./postgres-prism-inbox-store";

const now = new Date("2026-09-02T00:00:00.000Z");

describe("Postgres Prism Inbox authorization", () => {
  it("rechecks the current workspace grant while matching a Route", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const database = { query, transaction: async (work: (tx: Database) => Promise<unknown>) => work({ query, transaction: vi.fn() } as unknown as Database) } as unknown as Database;
    const store = createPostgresPrismInboxStore(database);

    await store.deliverBlockAction({
      routeKey: "opaque-route-key",
      envelopeId: "envelope-1",
      apiAppId: "A1234567890",
      workspaceId: "T123",
      enterpriseId: "E123",
      slackUserId: "U123",
      channelId: "C123",
      messageTs: "1788148800.000100",
      blockId: "block-1",
      actionId: "prism.route.opaque-route-key",
      actionType: "static_select",
      selectedOptionValue: "option-1",
      receivedAt: now,
      expiresAt: new Date("2026-09-03T00:00:00.000Z")
    });

    const routeSql = String(query.mock.calls[0]?.[0]);
    expect(routeSql).toContain("c.installation_scope = 'workspace' and c.team_id = r.workspace_id");
    expect(routeSql).toContain("slack_connection_workspace_grants g");
    expect(routeSql).toContain("g.status = 'active'");
  });

  it("rechecks capability, connection, Route, and workspace grant before leasing a Delivery", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const database = { query, transaction: vi.fn() } as unknown as Database;
    const store = createPostgresPrismInboxStore(database);

    await store.leaseDeliveries({
      tokenProfileId: "profile-1",
      limit: 10,
      now,
      leaseExpiresAt: new Date("2026-09-02T00:01:00.000Z")
    });

    const leaseSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("with candidates")) ?? "";
    const routeCleanupSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("delete from prism_slack_inbound_routes")) ?? "";
    expect(leaseSql).toContain("p.capability_map #>> '{inbound,blockActions}'");
    expect(leaseSql).toContain("c.status = 'healthy'");
    expect(leaseSql).not.toContain("r.status = 'active'");
    expect(leaseSql).toContain("slack_connection_workspace_grants g");
    expect(routeCleanupSql).toContain("candidate.closed_at < $1 - interval '1 day'");
    expect(routeCleanupSql).toContain("not exists");
  });
});
