import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleSlackConfigurationVerifyPost } from "./handler";

describe("POST /v1/prism/setup/slack-configuration/verify", () => {
  beforeEach(() => vi.stubEnv("PRISM_PUBLIC_BASE_URL", "http://localhost:3732"));

  it("starts OAuth for the server-selected pending version without browser identifiers", async () => {
    const startVerification = vi.fn().mockResolvedValue({
      redirectUrl: "https://slack.com/oauth/v2/authorize?redacted=yes",
      cookie: { name: "prism_slack_oauth_state", value: "oauth-state-cookie", httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 600 }
    });
    const response = await handleSlackConfigurationVerifyPost(request(), { startVerification });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://slack.com/oauth/v2/authorize?redacted=yes");
    expect(response.headers.get("set-cookie")).toMatch(/prism_slack_oauth_state=oauth-state-cookie/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(startVerification).toHaveBeenCalledWith({ setupSessionToken: "setup-session-token", requestId: expect.any(String) });
  });

  it("rejects query/body configuration selectors and missing sessions", async () => {
    const startVerification = vi.fn();
    const query = await handleSlackConfigurationVerifyPost(request("?versionId=attacker"), { startVerification });
    const body = await handleSlackConfigurationVerifyPost(request("", "versionId=attacker"), { startVerification });
    const missing = await handleSlackConfigurationVerifyPost(request("", "", false), { startVerification });

    expect(query.status).toBe(400);
    expect(body.status).toBe(400);
    expect(missing.status).toBe(303);
    expect(missing.headers.get("location")).toBe("http://localhost:3732/setup?error=session_expired");
    expect(startVerification).not.toHaveBeenCalled();
  });

  it("rejects cross-origin verification", async () => {
    const startVerification = vi.fn();
    const response = await handleSlackConfigurationVerifyPost(request("", "", true, "https://attacker.invalid"), { startVerification });
    expect(response.status).toBe(403);
    expect(startVerification).not.toHaveBeenCalled();
  });
});

function request(search = "", body = "", withCookie = true, origin = "http://localhost:3732") {
  return new NextRequest(`http://localhost:3732/v1/prism/setup/slack-configuration/verify${search}`, {
    method: "POST",
    headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...(withCookie ? { cookie: "prism_setup_session=setup-session-token" } : {}) },
    body
  });
}
