import { describe, expect, it } from "vitest";

import { localAppHtmlResponse, localAppJsonResponse, localAppRedirect } from "./http";

describe("local-app authorization HTTP responses", () => {
  it("exposes only the Prism origin for same-origin HTML form submissions", () => {
    const response = localAppHtmlResponse("<p>approval</p>", 200, "request-id");

    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("keeps machine responses and OAuth redirects fully no-referrer", () => {
    const json = localAppJsonResponse({ ok: true });
    const redirect = localAppRedirect("https://prism.example/v1/slack/oauth/start");

    expect(json.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(redirect.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});
