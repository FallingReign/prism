import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ claim: vi.fn(), complete: vi.fn(), attach: vi.fn(), scheduled: [] as Array<() => Promise<void>> }));
vi.mock("@/src/server/config", () => ({ getSlackSigningSecret: () => "signing-secret", getRemoteCodexConfig: () => ({ enabled: true }), isSetupRequiredError: () => false }));
vi.mock("@/src/server/db", () => ({ database: {} }));
vi.mock("@/src/server/http/deferred-work", () => ({ scheduleAfterResponse: (task: () => Promise<void>) => mocks.scheduled.push(task) }));
vi.mock("@/src/server/slack/inbound-receipts", () => ({ createPostgresSlackInboundReceiptStore: () => ({ claim: mocks.claim, complete: mocks.complete }) }));
vi.mock("@/src/server/remote-codex/binding-postgres-store", () => ({ createPostgresBindingStore: () => ({}) }));
vi.mock("@/src/server/remote-codex/binding-service", () => ({ createRemoteCodexBindingService: () => ({ attach: mocks.attach }) }));
vi.mock("@/src/server/remote-codex/internal-slack-service", () => ({ createDefaultRemoteCodexSlackService: () => ({}) }));
vi.mock("@/src/server/remote-codex/slack-rate-limit", () => ({ createRemoteCodexSlackRateLimiter: () => vi.fn() }));

describe("POST /v1/slack/interactivity", () => {
  beforeEach(() => {
    mocks.claim.mockReset().mockResolvedValue(true);
    mocks.complete.mockReset().mockResolvedValue(undefined);
    mocks.attach.mockReset().mockResolvedValue({ kind: "attached", permalink: "https://slack.com/archives/D123/p1788148800000100", existing: false });
    mocks.scheduled.length = 0;
  });

  it("binds the selected session to the exact signed Slack actor", async () => {
    const value = Buffer.from(JSON.stringify({ installationId: "rc_install_1", threadId: "thread_1" })).toString("base64url");
    const payload = { type: "block_actions", api_app_id: "A123", team: { id: "T123" }, user: { id: "U123" }, actions: [{ action_id: "remote_codex_share_session", value }] };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const { POST } = await import("./route");
    const result = await POST(signedRequest(body));
    expect(result.status).toBe(200);
    expect(mocks.attach).not.toHaveBeenCalled();
    await mocks.scheduled[0]?.();
    expect(mocks.attach).toHaveBeenCalledWith(expect.objectContaining({ source: "slack", teamId: "T123", appId: "A123", slackUserId: "U123", installationId: "rc_install_1", threadId: "thread_1" }));
  });

  it("does not parse or attach an unsigned action", async () => {
    const { POST } = await import("./route");
    const request = signedRequest("payload=%7Bbad");
    request.headers.set("x-slack-signature", "v0=" + "0".repeat(64));
    const result = await POST(request);
    expect(result.status).toBe(401);
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});

function signedRequest(body: string): NextRequest {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${createHmac("sha256", "signing-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new NextRequest("https://prism.example/v1/slack/interactivity", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } });
}
