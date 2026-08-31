import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifySlackInboundRequest } from "./inbound-signature";

describe("Slack inbound request signatures", () => {
  const signingSecret = "slack-signing-secret-for-tests";
  const now = new Date("2026-08-31T09:00:00.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const rawBody = JSON.stringify({ type: "event_callback", event_id: "Ev123" });

  it("verifies the exact raw body and a fresh Slack v0 timestamp", () => {
    const signature = sign(timestamp, rawBody);
    expect(verifySlackInboundRequest({ signingSecret, timestamp, signature, rawBody, now })).toBe(true);
    expect(verifySlackInboundRequest({ signingSecret, timestamp, signature, rawBody: `${rawBody} `, now })).toBe(false);
  });

  it("rejects stale timestamps, malformed signatures, and missing headers", () => {
    expect(verifySlackInboundRequest({ signingSecret, timestamp: String(Number(timestamp) - 301), signature: sign(timestamp, rawBody), rawBody, now })).toBe(false);
    expect(verifySlackInboundRequest({ signingSecret, timestamp, signature: "v0=bad", rawBody, now })).toBe(false);
    expect(verifySlackInboundRequest({ signingSecret, timestamp: null, signature: null, rawBody, now })).toBe(false);
  });

  function sign(valueTimestamp: string, body: string): string {
    return `v0=${createHmac("sha256", signingSecret).update(`v0:${valueTimestamp}:${body}`).digest("hex")}`;
  }
});
