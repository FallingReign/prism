import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { readJsonRecord } from "./prism-inbox-http";

describe("Prism Inbox HTTP input", () => {
  it("accepts a small JSON object and rejects other media types", async () => {
    const json = new NextRequest("http://localhost/v1/prism/slack/inbound-routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "T123" })
    });
    const text = new NextRequest("http://localhost/v1/prism/slack/inbound-routes", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ workspaceId: "T123" })
    });

    await expect(readJsonRecord(json)).resolves.toEqual({ workspaceId: "T123" });
    await expect(readJsonRecord(text)).resolves.toBeNull();
  });

  it("rejects an Inbox body larger than eight KiB without reflecting it", async () => {
    const request = new NextRequest("http://localhost/v1/prism/slack/inbox/delivery/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId: "x".repeat(9 * 1024) })
    });

    await expect(readJsonRecord(request)).resolves.toBeNull();
  });
});
