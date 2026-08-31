import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(), complete: vi.fn(), publish: vi.fn(),
  database: { query: vi.fn(), transaction: vi.fn() },
  scheduled: [] as Array<() => Promise<void>>
}));

vi.mock("@/src/server/config", () => ({
  getSlackSigningSecret: () => "signing-secret",
  getRemoteCodexConfig: () => ({ enabled: true, publicBaseUrl: "https://prism.example", trustProxyHeaders: false }),
  isSetupRequiredError: () => false
}));
vi.mock("@/src/server/db", () => ({ database: mocks.database }));
vi.mock("@/src/server/http/deferred-work", () => ({ scheduleAfterResponse: (task: () => Promise<void>) => mocks.scheduled.push(task) }));
vi.mock("@/src/server/slack/inbound-receipts", () => ({ createPostgresSlackInboundReceiptStore: () => ({ claim: mocks.claim, complete: mocks.complete }) }));
vi.mock("@/src/server/remote-codex/app-home-service", () => ({ publishRemoteCodexAppHome: mocks.publish }));
vi.mock("@/src/server/remote-codex/internal-slack-service", () => ({ createDefaultRemoteCodexSlackService: () => ({}) }));
vi.mock("@/src/server/remote-codex/slack-rate-limit", () => ({ createRemoteCodexSlackRateLimiter: () => vi.fn() }));

describe("POST /v1/slack/events", () => {
  beforeEach(() => {
    mocks.claim.mockReset().mockResolvedValue(true);
    mocks.complete.mockReset().mockResolvedValue(undefined);
    mocks.publish.mockReset().mockResolvedValue("published");
    mocks.scheduled.length = 0;
  });

  it("verifies the exact raw body before publishing the exact actor's App Home", async () => {
    const body = JSON.stringify({
      type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev_123",
      authorizations: [{ team_id: "T123", enterprise_id: null, user_id: "B123", is_bot: true }],
      event: { type: "app_home_opened", user: "U123" }
    });
    const { POST } = await import("./route");
    const result = await POST(signedRequest(body));
    expect(result.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ teamId: "T123", callbackId: "Ev_123", callbackType: "event" }));
    expect(mocks.publish).not.toHaveBeenCalled();
    await mocks.scheduled[0]?.();
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ teamId: "T123", appId: "A123", slackUserId: "U123", connectUrl: "https://prism.example/remote-codex" }));
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "processed" }));
  });

  it("rejects an invalid signature before parsing or touching storage", async () => {
    const { POST } = await import("./route");
    const request = signedRequest("not-json");
    request.headers.set("x-slack-signature", "v0=" + "0".repeat(64));
    const result = await POST(request);
    expect(result.status).toBe(401);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("answers Slack URL verification only after signature verification", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "challenge-safe" });
    const { POST } = await import("./route");
    const result = await POST(signedRequest(body));
    await expect(result.json()).resolves.toEqual({ challenge: "challenge-safe" });
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});

function signedRequest(body: string): NextRequest {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${createHmac("sha256", "signing-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new NextRequest("https://prism.example/v1/slack/events", { method: "POST", body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } });
}
