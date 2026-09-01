import { describe, expect, it } from "vitest";

import {
  delegatedErrorResponse,
  delegatedHtmlResponse,
  delegatedJsonResponse,
  delegatedRedirect
} from "./http";

describe("delegated Slack-message HTTP responses", () => {
  it("keeps the correlation UUID separate from a semantic delegation request id", async () => {
    const correlationId = "11111111-2222-4333-8444-555555555555";
    const response = delegatedJsonResponse({ request_id: "ddr_1234567890123456" }, 201, correlationId);

    await expect(response.json()).resolves.toEqual({ request_id: "ddr_1234567890123456" });
    expect(response.headers.get("X-Prism-Request-ID")).toBe(correlationId);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("uses the same correlation id in delegated error JSON and the response header", async () => {
    const correlationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const response = delegatedErrorResponse(
      { kind: "error", status: 429, error: "rate_limited", retryAfterSeconds: 7 },
      correlationId
    );

    await expect(response.json()).resolves.toEqual({
      error: "rate_limited",
      request_id: correlationId,
      retry_after_seconds: 7
    });
    expect(response.headers.get("X-Prism-Request-ID")).toBe(correlationId);
    expect(response.headers.get("Retry-After")).toBe("7");
  });

  it("exposes only the Prism origin for same-origin HTML consent forms", () => {
    const response = delegatedHtmlResponse("<p>authorization</p>", 200, "request-id");

    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("keeps machine responses and redirects fully no-referrer", () => {
    const json = delegatedJsonResponse({ ok: true });
    const redirect = delegatedRedirect("https://prism.example/return");

    expect(json.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(redirect.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});
