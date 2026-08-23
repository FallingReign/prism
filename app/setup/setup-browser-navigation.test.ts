import { describe, expect, it, vi } from "vitest";

import { prepareSetupBrowserTransaction } from "./setup-browser-navigation";

describe("setup browser navigation", () => {
  const proof = `v1.${"1".repeat(13)}.${"a".repeat(43)}.${"b".repeat(43)}`;

  it("prepares a signed short-lived proof without URL parameters or browser storage", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, url: "http://localhost:3732/v1/prism/setup/browser-transaction", json: vi.fn().mockResolvedValue({ proof }) });
    await expect(prepareSetupBrowserTransaction({ fetcher })).resolves.toBe(proof);
    expect(fetcher).toHaveBeenCalledWith("/v1/prism/setup/browser-transaction", { method: "GET", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
  });
});
