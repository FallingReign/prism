import { describe, expect, it } from "vitest";

import { slackSuccessResponse } from "./response-adapter";

describe("Slack-compatible response adapter", () => {
  it("returns successful Slack bodies unwrapped and moves Prism diagnostics into headers", async () => {
    const slackBody = { ok: true, channel: "C123", ts: "1700000000.000100", message: { text: "hello" } };

    const response = slackSuccessResponse(slackBody, {
      requestId: "req_success",
      policyDecision: "allowed",
      executionMode: "bot",
      upstreamCalled: true
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(slackBody);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-request-id")).toBe("req_success");
    expect(response.headers.get("x-prism-policy-decision")).toBe("allowed");
    expect(response.headers.get("x-prism-execution-mode")).toBe("bot");
    expect(response.headers.get("x-prism-upstream-called")).toBe("true");
    expect(JSON.stringify(Object.fromEntries(response.headers))).not.toMatch(/xox[bp]-|prism_dev_|tokenHash|refresh|access_token|client_secret/i);
  });
});
