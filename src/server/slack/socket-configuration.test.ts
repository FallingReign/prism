import { describe, expect, it } from "vitest";

import { createTestDatabase } from "../../../test/database";

import { loadSlackSocketConfiguration } from "./socket-configuration";

describe("Slack Socket Mode configuration", () => {
  it("loads a valid environment bootstrap without exposing its token in the summary", async () => {
    const database = createTestDatabase(async () => ({ rows: [], rowCount: 0 }));
    const config = await loadSlackSocketConfiguration({
      env: {
        NODE_ENV: "test",
        SLACK_SOCKET_MODE_ENABLED: "1",
        SLACK_APP_TOKEN: "xapp-1-A1234567890-secretvalue",
        SLACK_API_APP_ID: "A1234567890"
      },
      database
    });

    expect(config).toMatchObject({ enabled: true, source: "environment", apiAppId: "A1234567890" });
    expect(config.appToken).toBe("xapp-1-A1234567890-secretvalue");
    expect(JSON.stringify({ ...config, appToken: undefined })).not.toContain("secretvalue");
    expect(database.query).not.toHaveBeenCalled();
  });

  it("fails closed when Socket Mode is enabled with an incomplete environment bootstrap", async () => {
    await expect(loadSlackSocketConfiguration({
      env: { NODE_ENV: "test", SLACK_SOCKET_MODE_ENABLED: "1", SLACK_API_APP_ID: "A1234567890" },
      database: createTestDatabase(async () => ({ rows: [], rowCount: 0 }))
    })).rejects.toThrow("slack-socket-configuration-invalid");
  });

  it("stays disabled without requiring an app token", async () => {
    const database = createTestDatabase(async () => ({ rows: [], rowCount: 0 }));
    await expect(loadSlackSocketConfiguration({ env: { NODE_ENV: "test" }, database })).resolves.toEqual({ enabled: false, source: "none", apiAppId: null, appToken: null });
  });
});
