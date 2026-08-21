import { describe, expect, it } from "vitest";

import {
  resolveDelegatedDeliverySource,
  UNATTRIBUTED_DELEGATED_SOURCE
} from "./request-source";

describe("delegated delivery request source", () => {
  it("ignores attacker-selected forwarding headers by default", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.20",
      "x-real-ip": "203.0.113.21"
    });
    expect(resolveDelegatedDeliverySource(headers, false)).toBe(
      UNATTRIBUTED_DELEGATED_SOURCE
    );
  });

  it("normalizes one trusted ingress address", () => {
    expect(
      resolveDelegatedDeliverySource(
        new Headers({ "x-forwarded-for": " 2001:DB8::1 " }),
        true
      )
    ).toBe("2001:db8::1");
    expect(
      resolveDelegatedDeliverySource(
        new Headers({
          "x-forwarded-for": "192.0.2.42",
          "x-real-ip": "192.0.2.42"
        }),
        true
      )
    ).toBe("192.0.2.42");
  });

  it.each([
    ["missing", new Headers()],
    ["multiple", new Headers({ "x-forwarded-for": "192.0.2.1, 10.0.0.1" })],
    ["malformed", new Headers({ "x-real-ip": "not-an-ip" })],
    [
      "disagreeing",
      new Headers({
        "x-forwarded-for": "192.0.2.1",
        "x-real-ip": "192.0.2.2"
      })
    ],
    ["oversized", new Headers({ "x-forwarded-for": "1".repeat(65) })]
  ])("fails closed for %s trusted-ingress headers", (_label, headers) => {
    expect(resolveDelegatedDeliverySource(headers, true)).toBeNull();
  });
});
