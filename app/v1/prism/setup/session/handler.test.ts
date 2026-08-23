import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleSetupSessionPost } from "./handler";

const SETUP_PROOF = `v1.${"1".repeat(13)}.${"a".repeat(43)}.${"b".repeat(43)}`;

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
    expect(response.headers.get("set-cookie")).toMatch(/prism_setup_browser_transaction=;/i);
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

  it("uses the configured public origin for invalid, rate-limited, and successful redirects", async () => {
    const internalUrl = "http://0.0.0.0:3732/v1/prism/setup/session";
    const dependencies = (exchangeCapability: ReturnType<typeof vi.fn>) => ({ exchangeCapability, expectedOrigin: "http://localhost:3732" });
    const invalidResponse = await handleSetupSessionPost(formRequest("x".repeat(40), "http://localhost:3732", {}, internalUrl), dependencies(vi.fn().mockResolvedValue(null)));
    const rateError = Object.assign(new Error("rate limited"), { retryAfterSeconds: 10 });
    const rateResponse = await handleSetupSessionPost(formRequest("x".repeat(40), "http://localhost:3732", {}, internalUrl), dependencies(vi.fn().mockRejectedValue(rateError)));
    const successResponse = await handleSetupSessionPost(formRequest("x".repeat(40), "http://localhost:3732", {}, internalUrl), dependencies(vi.fn().mockResolvedValue({ sessionToken: "session", expiresAt: new Date(Date.now() + 60_000) })));

    expect(invalidResponse.headers.get("location")).toBe("http://localhost:3732/setup?error=invalid_or_expired");
    expect(rateResponse.headers.get("location")).toBe("http://localhost:3732/setup?error=rate_limited");
    expect(successResponse.headers.get("location")).toBe("http://localhost:3732/setup");
  });

  it("rejects duplicate and unknown form fields before exchange", async () => {
    const exchangeCapability = vi.fn();
    const duplicate = new NextRequest("http://localhost:3732/v1/prism/setup/session", { method: "POST", headers: sameOriginHeaders({ "content-type": "application/x-www-form-urlencoded" }), body: `setupCode=${"a".repeat(40)}&setupCode=${"b".repeat(40)}&setupProof=${SETUP_PROOF}` });
    const unknown = new NextRequest("http://localhost:3732/v1/prism/setup/session", { method: "POST", headers: sameOriginHeaders({ "content-type": "application/x-www-form-urlencoded" }), body: `setupCode=${"a".repeat(40)}&setupProof=${SETUP_PROOF}&returnTo=%2Fadmin` });

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

  it("requires the exact form media-type essence while accepting normal casing, whitespace, and parameters", async () => {
    const exchangeCapability = vi.fn().mockResolvedValue({ sessionToken: "browser-session-token", expiresAt: new Date(Date.now() + 60_000) });
    const code = "one-time-code-canary-value-that-is-long-enough";
    const prefixed = await handleSetupSessionPost(formRequest(code, "http://localhost:3732", {
      "content-type": "application/x-www-form-urlencoded-evil"
    }), { exchangeCapability });
    const parameterized = await handleSetupSessionPost(formRequest(code, "http://localhost:3732", {
      "content-type": " Application/X-WWW-Form-Urlencoded ; charset=UTF-8 "
    }), { exchangeCapability });

    expect(prefixed.status).toBe(415);
    expect(parameterized.status).toBe(303);
    expect(exchangeCapability).toHaveBeenCalledOnce();
  });

  it("returns a friendly configured-origin redirect when a native form proof is unavailable", async () => {
    const exchangeCapability = vi.fn();
    const request = new NextRequest("http://localhost:3732/v1/prism/setup/session", {
      method: "POST",
      headers: { "sec-fetch-site": "none", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ setupCode: "x".repeat(40), setupProof: SETUP_PROOF }).toString()
    });

    const response = await handleSetupSessionPost(request, { exchangeCapability });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3732/setup?error=secure_form_expired");
    expect(exchangeCapability).not.toHaveBeenCalled();
  });

  it.each([
    ["exact origin with none and cookie", "http://localhost:3732", "none", true],
    ["opaque origin with none", "null", "none", true],
    ["missing metadata", null, null, true]
  ])("accepts a valid browser synchronizer for %s", async (_label, origin, fetchSite, withCookie) => {
    const exchangeCapability = vi.fn().mockResolvedValue(null);
    const response = await handleSetupSessionPost(browserProofRequest(origin, fetchSite, SETUP_PROOF, withCookie), browserProofDependencies(exchangeCapability));

    expect(response.status).toBe(303);
    expect(exchangeCapability).toHaveBeenCalledOnce();
    expect(response.headers.get("set-cookie")).toMatch(/prism_setup_browser_transaction=;/i);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it.each([
    ["attacker origin", "https://attacker.invalid", "none", SETUP_PROOF],
    ["cross-site", null, "cross-site", SETUP_PROOF],
    ["same-site", null, "same-site", SETUP_PROOF],
    ["mismatched proof", null, "none", `v1.${"1".repeat(13)}.${"a".repeat(43)}.${"c".repeat(43)}`]
  ])("rejects a synchronizer with %s", async (_label, origin, fetchSite, proof) => {
    const exchangeCapability = vi.fn();
    const response = await handleSetupSessionPost(browserProofRequest(origin, fetchSite, proof), browserProofDependencies(exchangeCapability));

    const hostileMetadata = origin === "https://attacker.invalid" || fetchSite === "cross-site" || fetchSite === "same-site";
    expect(response.status).toBe(hostileMetadata ? 403 : 303);
    if (!hostileMetadata) expect(response.headers.get("location")).toBe("http://localhost:3732/setup?error=secure_form_expired");
    expect(exchangeCapability).not.toHaveBeenCalled();
  });

  it("rejects duplicate raw browser-transaction cookies before proof validation", async () => {
    const exchangeCapability = vi.fn().mockResolvedValue(null);
    const response = await handleSetupSessionPost(
      browserProofRequest(null, null, SETUP_PROOF, true, "prism_setup_browser_transaction=signed-browser-cookie; prism_setup_browser_transaction=signed-browser-cookie"),
      browserProofDependencies(exchangeCapability)
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3732/setup?error=secure_form_expired");
    expect(exchangeCapability).not.toHaveBeenCalled();
  });
});

function browserProofDependencies(exchangeCapability: ReturnType<typeof vi.fn>) {
  return {
    exchangeCapability,
    expectedOrigin: "http://localhost:3732",
    secureBrowserTransactionCookie: false,
    validateBrowserTransaction: (cookieValue: string | undefined, proof: string) => cookieValue === "signed-browser-cookie" && proof === SETUP_PROOF
  };
}

function browserProofRequest(origin: string | null, fetchSite: string | null, proof = SETUP_PROOF, withCookie = true, cookieHeader?: string) {
  return new NextRequest("http://localhost:3732/v1/prism/setup/session", {
    method: "POST",
    headers: {
      ...(origin !== null ? { origin } : {}),
      ...(fetchSite !== null ? { "sec-fetch-site": fetchSite } : {}),
      "content-type": "application/x-www-form-urlencoded",
      ...(withCookie ? { cookie: cookieHeader ?? "prism_setup_browser_transaction=signed-browser-cookie" } : {})
    },
    body: new URLSearchParams({ setupCode: "x".repeat(40), setupProof: proof }).toString()
  });
}

function formRequest(code: string, origin = "http://localhost:3732", forwardingHeaders: Record<string, string> = {}, requestUrl = "http://localhost:3732/v1/prism/setup/session") {
  return new NextRequest(requestUrl, {
    method: "POST",
    headers: sameOriginHeaders({ "content-type": "application/x-www-form-urlencoded", origin, ...forwardingHeaders }),
    body: new URLSearchParams({ setupCode: code, setupProof: SETUP_PROOF }).toString()
  });
}

function sameOriginHeaders(extra: Record<string, string> = {}) {
  return { origin: "http://localhost:3732", "sec-fetch-site": "same-origin", ...extra };
}
