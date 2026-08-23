import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleSlackConfigurationVerifyPost } from "./handler";

const SETUP_PROOF = `v1.${"1".repeat(13)}.${"a".repeat(43)}.${"b".repeat(43)}`;

describe("POST /v1/prism/setup/slack-configuration/verify", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PRISM_PUBLIC_BASE_URL", "http://localhost:3732");
    vi.stubEnv("PRISM_OIDC_ALLOW_INSECURE_HTTP", "1");
  });

  it("starts OAuth for the server-selected pending version without browser identifiers", async () => {
    const startVerification = vi.fn().mockResolvedValue({
      redirectUrl: "https://slack.com/oauth/v2/authorize?state=opaque",
      cookie: { name: "prism_slack_oauth_state", value: "oauth-state-cookie", httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 600 }
    });
    const response = await handleSlackConfigurationVerifyPost(request(), { startVerification });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://slack.com/oauth/v2/authorize?state=opaque");
    expect(response.headers.get("set-cookie")).toMatch(/prism_slack_oauth_state=oauth-state-cookie/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(startVerification).toHaveBeenCalledWith({ setupSessionToken: "setup-session-token", requestId: expect.any(String) });
  });

  it("returns the existing Slack authorization URL contract as no-store JSON for same-origin fetch", async () => {
    const redirectUrl = "https://slack.com/oauth/v2/authorize?client_id=123&state=opaque";
    const startVerification = vi.fn().mockResolvedValue({
      redirectUrl,
      cookie: { name: "prism_slack_oauth_state", value: "oauth-state-cookie", httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 600 }
    });
    const response = await handleSlackConfigurationVerifyPost(request("", undefined, true, "http://localhost:3732", "application/json"), { startVerification });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectUrl });
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toMatch(/prism_slack_oauth_state=oauth-state-cookie/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Accept");
  });

  it("rejects query/body configuration selectors and missing sessions", async () => {
    const startVerification = vi.fn();
    const query = await handleSlackConfigurationVerifyPost(request("?versionId=attacker"), { startVerification });
    const body = await handleSlackConfigurationVerifyPost(request("", "versionId=attacker"), { startVerification });
    const missing = await handleSlackConfigurationVerifyPost(request("", undefined, false), { startVerification });

    expect(query.status).toBe(400);
    expect(body.status).toBe(400);
    expect(missing.status).toBe(303);
    expect(missing.headers.get("location")).toBe("http://localhost:3732/setup?error=session_expired");
    expect(startVerification).not.toHaveBeenCalled();
  });

  it("rejects cross-origin verification", async () => {
    const startVerification = vi.fn();
    const response = await handleSlackConfigurationVerifyPost(request("", undefined, true, "https://attacker.invalid"), { startVerification });
    expect(response.status).toBe(403);
    expect(startVerification).not.toHaveBeenCalled();
  });

  it("still rejects native top-level and cross-origin JSON requests", async () => {
    const startVerification = vi.fn();
    const native = await handleSlackConfigurationVerifyPost(request("", undefined, true, null, "application/json", "none"), { startVerification });
    const crossOrigin = await handleSlackConfigurationVerifyPost(request("", undefined, true, "https://attacker.invalid", "application/json", "cross-site"), { startVerification });

    expect(native.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(startVerification).not.toHaveBeenCalled();
  });

  it("requires the exact form media-type essence while accepting normal casing, whitespace, and parameters", async () => {
    const startVerification = vi.fn().mockResolvedValue(validStart());
    const mediaRequest = (contentType: string) => new NextRequest("http://localhost:3732/v1/prism/setup/slack-configuration/verify", {
      method: "POST",
      headers: {
        origin: "http://localhost:3732",
        "sec-fetch-site": "same-origin",
        "content-type": contentType,
        cookie: "prism_setup_session=setup-session-token"
      },
      body: new URLSearchParams({ setupProof: SETUP_PROOF }).toString()
    });

    const prefixed = await handleSlackConfigurationVerifyPost(mediaRequest("application/x-www-form-urlencoded-evil"), { startVerification });
    const parameterized = await handleSlackConfigurationVerifyPost(mediaRequest(" Application/X-WWW-Form-Urlencoded ; charset=UTF-8 "), { startVerification });

    expect(prefixed.status).toBe(415);
    expect(parameterized.status).toBe(303);
    expect(startVerification).toHaveBeenCalledOnce();
  });

  it("does not return or navigate to an unexpected verification destination", async () => {
    const startVerification = vi.fn().mockResolvedValue({
      redirectUrl: "https://attacker.invalid/oauth/v2/authorize?state=opaque",
      cookie: { name: "prism_slack_oauth_state", value: "must-not-be-set", httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 600 }
    });
    const response = await handleSlackConfigurationVerifyPost(request("", undefined, true, "http://localhost:3732", "application/json"), { startVerification });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "verification_unavailable" });
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toMatch(/prism_setup_browser_transaction=;/i);
    expect(response.headers.get("set-cookie")).not.toMatch(/prism_slack_oauth_state=/i);
  });

  it("uses the configured public origin for native setup errors behind an internal host", async () => {
    const response = await handleSlackConfigurationVerifyPost(new NextRequest("http://0.0.0.0:3732/v1/prism/setup/slack-configuration/verify", {
      method: "POST",
      headers: { origin: "http://localhost:3732", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ setupProof: SETUP_PROOF }).toString()
    }), { startVerification: vi.fn(), expectedOrigin: "http://localhost:3732" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3732/setup?error=session_expired");
  });

  it.each([
    ["exact origin with none and cookie", "http://localhost:3732", "none", true],
    ["opaque origin with none", "null", "none", true],
    ["missing metadata", null, null, true]
  ])("accepts a valid browser synchronizer for verification with %s", async (_label, origin, fetchSite, withCookie) => {
    const startVerification = vi.fn().mockResolvedValue(validStart());
    const response = await handleSlackConfigurationVerifyPost(verificationProofRequest(origin, fetchSite, SETUP_PROOF, withCookie), verificationProofDependencies(startVerification));

    expect(response.status).toBe(200);
    expect(startVerification).toHaveBeenCalledOnce();
    expect(response.headers.get("set-cookie")).toMatch(/prism_setup_browser_transaction=;/i);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it.each([
    ["attacker origin", "https://attacker.invalid", "none", SETUP_PROOF],
    ["cross-site", null, "cross-site", SETUP_PROOF],
    ["same-site", null, "same-site", SETUP_PROOF],
    ["mismatched proof", null, "none", `v1.${"1".repeat(13)}.${"a".repeat(43)}.${"c".repeat(43)}`]
  ])("rejects verification synchronizer with %s", async (_label, origin, fetchSite, proof) => {
    const startVerification = vi.fn();
    const response = await handleSlackConfigurationVerifyPost(verificationProofRequest(origin, fetchSite, proof), verificationProofDependencies(startVerification));

    expect(response.status).toBe(403);
    expect(startVerification).not.toHaveBeenCalled();
  });
});

function validStart() {
  return {
    redirectUrl: "https://slack.com/oauth/v2/authorize?client_id=123&state=opaque",
    cookie: { name: "prism_slack_oauth_state", value: "oauth-state-cookie", httpOnly: true as const, sameSite: "lax" as const, secure: false, path: "/", maxAge: 600 }
  };
}

function verificationProofDependencies(startVerification: ReturnType<typeof vi.fn>) {
  return {
    startVerification,
    expectedOrigin: "http://localhost:3732",
    secureBrowserTransactionCookie: false,
    validateBrowserTransaction: (cookieValue: string | undefined, proof: string) => cookieValue === "signed-browser-cookie" && proof === SETUP_PROOF
  };
}

function verificationProofRequest(origin: string | null, fetchSite: string | null, proof = SETUP_PROOF, withCookie = true) {
  return new NextRequest("http://localhost:3732/v1/prism/setup/slack-configuration/verify", {
    method: "POST",
    headers: {
      ...(origin !== null ? { origin } : {}),
      ...(fetchSite !== null ? { "sec-fetch-site": fetchSite } : {}),
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      cookie: `prism_setup_session=setup-session-token${withCookie ? "; prism_setup_browser_transaction=signed-browser-cookie" : ""}`
    },
    body: new URLSearchParams({ setupProof: proof }).toString()
  });
}

function request(search = "", body: string | undefined = undefined, withCookie = true, origin: string | null = "http://localhost:3732", accept?: string, fetchSite = "same-origin") {
  return new NextRequest(`http://localhost:3732/v1/prism/setup/slack-configuration/verify${search}`, {
    method: "POST",
    headers: { ...(origin ? { origin } : {}), "sec-fetch-site": fetchSite, "content-type": "application/x-www-form-urlencoded", ...(accept ? { accept } : {}), ...(withCookie ? { cookie: "prism_setup_session=setup-session-token" } : {}) },
    body: body ?? new URLSearchParams({ setupProof: SETUP_PROOF }).toString()
  });
}
