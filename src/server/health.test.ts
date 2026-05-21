import { describe, expect, it } from "vitest";

import { checkHealth } from "./health";

describe("Prism health", () => {
  it("reports the Prism hosted service and database as ok when the database probe succeeds", async () => {
    const health = await checkHealth({
      query: async () => undefined
    });

    expect(health).toEqual({ service: "ok", database: "ok" });
  });

  it("reports only sanitized unavailable status when the database probe fails", async () => {
    const health = await checkHealth({
      query: async () => {
        throw new Error("password=super-secret host=localhost stack trace");
      }
    });

    expect(health).toEqual({ service: "ok", database: "unavailable" });
    expect(JSON.stringify(health)).not.toMatch(/super-secret|password|host|stack/i);
  });
});
