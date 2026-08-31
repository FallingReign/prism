import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { createPostgresSlackInboundReceiptStore } from "./inbound-receipts";

describe("Slack inbound receipt retry policy", () => {
  it("reclaims failed or stale received callbacks but not completed callbacks", async () => {
    const now = new Date("2026-08-31T08:00:00.000Z");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("delete from")) return { rows: [], rowCount: 0 };
      expect(sql).toContain("slack_inbound_receipts.status = 'failed'");
      expect(sql).toContain("slack_inbound_receipts.status = 'received'");
      expect(sql).not.toMatch(/status = 'processed'.*where/s);
      expect(params?.[6]).toEqual(new Date("2026-08-31T07:55:00.000Z"));
      return { rows: [], rowCount: 1 };
    });
    await expect(createPostgresSlackInboundReceiptStore(fakeDatabase(query)).claim({
      teamId: "T123", callbackId: "Ev_123", callbackType: "event", retryNumber: 1, now
    })).resolves.toBe(true);
  });
});

function fakeDatabase(query: ReturnType<typeof vi.fn>): Database {
  const value: Database = { query: query as unknown as Database["query"], transaction: async (callback) => callback(value) };
  return value;
}
