import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { handleSetupBrowserTransactionGet, setupBrowserTransactionCookieName } from "./handler";

describe("GET /v1/prism/setup/browser-transaction", () => {
  it("returns only the proof and sets the signed transaction as an HttpOnly Strict cookie", async () => {
    const issue = vi.fn().mockReturnValue({ cookieValue: "signed-cookie-canary", proof: "browser-proof-canary", expiresAt: new Date(Date.now() + 300_000) });
    const response = await handleSetupBrowserTransactionGet(new NextRequest("http://localhost:3732/v1/prism/setup/browser-transaction"), { issue, secureCookie: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ proof: "browser-proof-canary" });
    expect(response.headers.get("set-cookie")).toContain(`${setupBrowserTransactionCookieName}=signed-cookie-canary`);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=strict/i);
    expect(response.headers.get("set-cookie")).toMatch(/Path=\/v1\/prism\/setup/i);
    expect(response.headers.get("set-cookie")).not.toContain("browser-proof-canary");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects every query without issuing or reflecting it", async () => {
    const issue = vi.fn();
    const response = await handleSetupBrowserTransactionGet(new NextRequest("http://localhost:3732/v1/prism/setup/browser-transaction?proof=secret-canary"), { issue, secureCookie: false });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(issue).not.toHaveBeenCalled();
  });
});
