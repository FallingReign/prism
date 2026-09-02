import { describe, expect, it, vi } from "vitest";

import { loadSlackSocketConfiguration } from "./socket-configuration";

describe("Slack Socket Mode configuration", () => {
  it("loads a valid environment bootstrap without exposing its token in the summary", async () => {
    const database = { query: vi.fn(), transaction: vi.fn() } as any;
    const config = await loadSlackSocketConfiguration({
      env: {
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
      env: { SLACK_SOCKET_MODE_ENABLED: "1", SLACK_API_APP_ID: "A1234567890" },
      database: { query: vi.fn(), transaction: vi.fn() } as any
    })).rejects.toThrow("slack-socket-configuration-invalid");
  });

  it("stays disabled without requiring an app token", async () => {
    const database = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), transaction: vi.fn() } as any;
    await expect(loadSlackSocketConfiguration({ env: {}, database })).resolves.toEqual({ enabled: false, source: "none", apiAppId: null, appToken: null });
  });
});
