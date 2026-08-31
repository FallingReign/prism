import { describe, expect, it } from "vitest";

import {
  UNATTRIBUTED_REMOTE_CODEX_SOURCE,
  remoteCodexSourceKey,
  resolveRemoteCodexPairingSource
} from "./request-source";

describe("Remote Codex pairing source attribution", () => {
  it("ignores spoofable forwarding headers until a trusted ingress is configured", () => {
    expect(resolveRemoteCodexPairingSource(headers({
      "x-forwarded-for": "203.0.113.10",
      "x-real-ip": "203.0.113.10"
    }), false)).toBe(UNATTRIBUTED_REMOTE_CODEX_SOURCE);
  });

  it("accepts one consistent address and fails closed on malformed trusted headers", () => {
    expect(resolveRemoteCodexPairingSource(headers({
      "x-forwarded-for": "203.0.113.10",
      "x-real-ip": "203.0.113.10"
    }), true)).toBe("203.0.113.10");
    expect(resolveRemoteCodexPairingSource(headers({ "x-forwarded-for": "203.0.113.10, 10.0.0.1" }), true)).toBeNull();
    expect(resolveRemoteCodexPairingSource(headers({
      "x-forwarded-for": "203.0.113.10",
      "x-real-ip": "203.0.113.11"
    }), true)).toBeNull();
    expect(resolveRemoteCodexPairingSource(headers({}), true)).toBeNull();
  });

  it("stores only a deployment-keyed source digest", () => {
    const first = remoteCodexSourceKey("203.0.113.10", Buffer.alloc(32, 1).toString("base64"));
    const second = remoteCodexSourceKey("203.0.113.10", Buffer.alloc(32, 2).toString("base64"));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("203.0.113.10");
  });
});

function headers(values: Record<string, string>): Pick<Headers, "get"> {
  return { get: (name) => values[name.toLowerCase()] ?? null };
}
