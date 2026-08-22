import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleSetupSessionPost } from "./handler";

describe("POST /v1/prism/setup/session", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PRISM_PUBLIC_BASE_URL", "http://localhost:3732");
    vi.stubEnv("PRISM_OIDC_ALLOW_INSECURE_HTTP", "1");
  });

  it("exchanges a same-origin form capability and sets only an HttpOnly setup session", async () => {
    const exchangeCapability = vi.fn().mockResolvedValue({ sessionToken: "browser-session-token", expiresAt: new Date(Date.now() + 20 * 60_000) });
    const code = "one-time-code-canary-value-that-is-long-enough";
    const response = await handleSetupSessionPost(formRequest(code), { exchangeCapability });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3732/setup");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-prism-request-id")).toBeTruthy();
    expect(response.headers.get("set-cookie")).toMatch(/prism_setup_session=browser-session-token/i);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=strict/i);
    expect(response.headers.get("set-cookie")).toMatch(/Path=\//i);
    expect(response.headers.get("set-cookie")).not.toMatch(/; Secure/i);
    expect(response.headers.get("set-cookie")).not.toMatch(/one-time-code-canary/i);
    expect(exchangeCapability).toHaveBeenCalledWith(expect.objectContaining({ code, requestId: expect.any(String) }));
  });

  it("sets Secure from the validated HTTPS deployment origin in development", async () => {
    vi.stubEnv("PRISM_PUBLIC_BASE_URL", "https://prism.example.test");
    const exchangeCapability = vi.fn().mockResolvedValue({ sessionToken: "browser-session-token", expiresAt: new Date(Date.now() + 20 * 60_000) });

    const response = await handleSetupSessionPost(
      formRequest("one-time-code-canary-value-that-is-long-enough", "https://prism.example.test"),
      { exchangeCapability }
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toMatch(/; Secure/i);
  });

  it("rejects every query string before CSRF, source, or body work without reflection", async () => {
    const queryCanary = "query-secret-canary-must-not-appear";
    const exchangeCapability = vi.fn();
    const request = new NextRequest(
      `http://localhost:3732/v1/prism/setup/session?setupCode=${queryCanary}`,
      {
        method: "POST",
        headers: {
          origin: "https://attacker.invalid",
          "sec-fetch-site": "cross-site",
          "content-type": "text/plain",
          "x-forwarded-for": "not-an-ip"
        },
        body: queryCanary
      }
    );

    const response = await handleSetupSessionPost(request, {
      exchangeCapability,
      trustProxyHeaders: true
    });
    const visible = `${response.headers.get("location") ?? ""} ${await response.text()}`;

    expect(response.status).toBe(400);
    expect(JSON.parse(visible.trim())).toEqual({ error: "invalid_request" });
    expect(visible).not.toContain(queryCanary);
    expect(exchangeCapability).not.toHaveBeenCalled();
  });

  it("ignores spoofed forwarding headers by default and skips source attribution", async () => {
    const exchangeCapability = vi.fn().mockResolvedValue({ sessionToken: "browser-session-token", expiresAt: new Date(Date.now() + 20 * 60_000) });
    const request = formRequest("one-time-code-canary-value-that-is-long-enough", "http://localhost:3732", {
      "x-forwarded-for": "attacker-selected, 192.0.2.1",
      "x-real-ip": "not-an-ip"
    });

    const response = await handleSetupSessionPost(request, { exchangeCapability, trustProxyHeaders: false });

    expect(response.status).toBe(303);
    expect(exchangeCapability).toHaveBeenCalledWith(expect.objectContaining({ sourceAddress: undefined }));
  });

  it("normalizes one trusted proxy source before exchange", async () => {
    const exchangeCapability = vi.fn().mockResolvedValue({ sessionToken: "browser-session-token", expiresAt: new Date(Date.now() + 20 * 60_000) });
    const request = formRequest("one-time-code-canary-value-that-is-long-enough", "http://localhost:3732", {
      "x-forwarded-for": " 2001:DB8::42 ",
      "x-real-ip": "2001:db8::42"
    });

    const response = await handleSetupSessionPost(request, { exchangeCapability, trustProxyHeaders: true });

    expect(response.status).toBe(303);
    expect(exchangeCapability).toHaveBeenCalledWith(expect.objectContaining({ sourceAddress: "2001:db8::42" }));
  });

  it.each([
    ["missing", {}],
    ["multiple", { "x-forwarded-for": "192.0.2.1, 10.0.0.1" }],
    ["malformed", { "x-real-ip": "not-an-ip" }],
    ["disagreeing", { "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.2" }]
  ])("rejects %s trusted proxy sources before exchange", async (_label, forwardingHeaders) => {
    const exchangeCapability = vi.fn();
    const request = formRequest("one-time-code-canary-value-that-is-long-enough", "http://localhost:3732", forwardingHeaders);

    const response = await handleSetupSessionPost(request, { exchangeCapability, trustProxyHeaders: true });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request_source" });
    expect(exchangeCapability).not.toHaveBeenCalled();
  });

  it("fails generically for a wrong, expired, or replayed capability", async () => {
    const code = "wrong-code-canary-value-that-is-long-enough";
    const response = await handleSetupSessionPost(formRequest(code), { exchangeCapability: vi.fn().mockResolvedValue(null) });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3732/setup?error=invalid_or_expired");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).not.toContain(code);
    expect(await response.text()).not.toContain(code);
  });

  it("rate limits generically without inspecting or reflecting the code", async () => {
    const code = "rate-limit-code-canary-value-that-is-long-enough";
    const error = Object.assign(new Error("rate limited"), { retryAfterSeconds: 42 });
    const response = await handleSetupSessionPost(formRequest(code), { exchangeCapability: vi.fn().mockRejectedValue(error) });
    const text = await response.text();

    expect(response.status).toBe(303);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("location")).toBe("http://localhost:3732/setup?error=rate_limited");
    expect(text).not.toContain(code);
  });

  it("rejects duplicate and unknown form fields before exchange", async () => {
    const exchangeCapability = vi.fn();
    const duplicate = new NextRequest("http://localhost:3732/v1/prism/setup/session", { method: "POST", headers: sameOriginHeaders({ "content-type": "application/x-www-form-urlencoded" }), body: `setupCode=${"a".repeat(40)}&setupCode=${"b".repeat(40)}` });
    const unknown = new NextRequest("http://localhost:3732/v1/prism/setup/session", { method: "POST", headers: sameOriginHeaders({ "content-type": "application/x-www-form-urlencoded" }), body: `setupCode=${"a".repeat(40)}&returnTo=%2Fadmin` });

    expect((await handleSetupSessionPost(duplicate, { exchangeCapability })).status).toBe(303);
    expect((await handleSetupSessionPost(unknown, { exchangeCapability })).status).toBe(303);
    expect(exchangeCapability).not.toHaveBeenCalled();
  });

  it("rejects cross-origin, unsupported, and oversized requests before exchange", async () => {
    const exchangeCapability = vi.fn();
    const crossOrigin = await handleSetupSessionPost(formRequest("x".repeat(40), "https://attacker.invalid"), { exchangeCapability });
    const unsupported = await handleSetupSessionPost(new NextRequest("http://localhost:3732/v1/prism/setup/session", { method: "POST", headers: sameOriginHeaders({ "content-type": "text/plain" }), body: "x".repeat(40) }), { exchangeCapability });
    const oversized = await handleSetupSessionPost(new NextRequest("http://localhost:3732/v1/prism/setup/session", { method: "POST", headers: sameOriginHeaders({ "content-type": "application/x-www-form-urlencoded", "content-length": "4097" }), body: "setupCode=x" }), { exchangeCapability });
    const streamedOversized = await handleSetupSessionPost(new NextRequest("http://localhost:3732/v1/prism/setup/session", { method: "POST", headers: sameOriginHeaders({ "content-type": "application/x-www-form-urlencoded" }), body: `setupCode=${"x".repeat(5000)}` }), { exchangeCapability });

    expect(crossOrigin.status).toBe(403);
    expect(unsupported.status).toBe(415);
    expect(oversized.status).toBe(413);
    expect(streamedOversized.status).toBe(413);
    expect(exchangeCapability).not.toHaveBeenCalled();
  });
});

function formRequest(code: string, origin = "http://localhost:3732", forwardingHeaders: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3732/v1/prism/setup/session", {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/x-www-form-urlencoded", origin, ...forwardingHeaders }),
    body: new URLSearchParams({ setupCode: code }).toString()
  });
}

function sameOriginHeaders(extra: Record<string, string> = {}) {
  return { origin: "http://localhost:3732", "sec-fetch-site": "same-origin", ...extra };
}
