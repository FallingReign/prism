import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { rejectCrossOriginBrowserMutation } from "./browser-mutation-csrf";

describe("rejectCrossOriginBrowserMutation", () => {
  it("allows only the exact configured origin when Origin is present", () => {
    vi.stubEnv("PRISM_PUBLIC_BASE_URL", "http://localhost:3732");
    expect(rejectCrossOriginBrowserMutation(request({ origin: "http://localhost:3732" }))).toBeNull();
    expect(rejectCrossOriginBrowserMutation(request({ origin: "http://localhost:3733" }))?.status).toBe(403);
    expect(rejectCrossOriginBrowserMutation(request({ origin: "http://localhost:3732/" }))?.status).toBe(403);
    expect(rejectCrossOriginBrowserMutation(request({
      origin: "http://localhost:3733",
      "sec-fetch-site": "same-origin"
    }))?.status).toBe(403);
  });

  it("accepts an unavailable Origin only with exact same-origin Fetch Metadata", () => {
    expect(rejectCrossOriginBrowserMutation(request({
      origin: "null",
      "sec-fetch-site": "same-origin"
    }))).toBeNull();
    expect(rejectCrossOriginBrowserMutation(request({ "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it("fails closed for null Origin without exact same-origin Fetch Metadata", () => {
    vi.stubEnv("PRISM_PUBLIC_BASE_URL", "http://localhost:3732");
    for (const headers of [
      { origin: "null" },
      { origin: "null", "sec-fetch-site": "none" },
      { origin: "null", "sec-fetch-site": "same-site" },
      { origin: "null", "sec-fetch-site": "cross-site" },
      { origin: "http://localhost:3732", "sec-fetch-site": "same-site" },
      { origin: "http://localhost:3732", "sec-fetch-site": "cross-site" },
      { origin: "http://localhost:3732", "sec-fetch-site": "none" }
    ]) {
      expect(rejectCrossOriginBrowserMutation(request(headers))?.status).toBe(403);
    }
  });

  it("fails closed when both browser signals are absent", () => {
    expect(rejectCrossOriginBrowserMutation(request({}))?.status).toBe(403);
  });

  it("rejects an Origin request when the configured public URL is not valid", () => {
    vi.stubEnv("PRISM_PUBLIC_BASE_URL", "replace-with-prism-public-base-url");
    expect(rejectCrossOriginBrowserMutation(request({ origin: "http://localhost:3732" }))?.status).toBe(403);
  });
});

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3732/v1/prism/token-profiles", { method: "POST", headers });
}
