import { describe, expect, it } from "vitest";

import { readAdapterConfig } from "./config";

describe("Prism MCP adapter config", () => {
  it("accepts only Prism config and rejects Slack credential-like environment variables with redacted errors", () => {
    expect(
      readAdapterConfig({
        PRISM_BASE_URL: "http://localhost:3732/",
        PRISM_DEVELOPER_TOKEN: "prism_dev_configcanaryconfigcanaryconfig12"
      })
    ).toEqual({
      baseUrl: "http://localhost:3732",
      developerToken: "prism_dev_configcanaryconfigcanaryconfig12"
    });

    expect(() =>
      readAdapterConfig({
        PRISM_BASE_URL: "http://localhost:3732",
        PRISM_DEVELOPER_TOKEN: "prism_dev_configcanaryconfigcanaryconfig12",
        SLACK_BOT_TOKEN: "xoxb-secret-canary",
        SLACK_CLIENT_SECRET: "client-secret-canary"
      })
    ).toThrow(/Slack credential-like environment variables are not allowed: SLACK_BOT_TOKEN, SLACK_CLIENT_SECRET/);

    try {
      readAdapterConfig({
        PRISM_BASE_URL: "http://localhost:3732",
        PRISM_DEVELOPER_TOKEN: "prism_dev_configcanaryconfigcanaryconfig12",
        SLACK_BOT_TOKEN: "xoxb-secret-canary"
      });
    } catch (error) {
      expect(String(error)).not.toMatch(/prism_dev_|xoxb-secret-canary|client-secret-canary/);
    }
  });
});
