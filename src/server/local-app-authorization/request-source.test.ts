import { describe, expect, it } from "vitest";

import { resolveLocalAppRequestSource, UNATTRIBUTED_LOCAL_APP_SOURCE } from "./request-source";

describe("local app request source", () => {
  it("ignores attacker-selected forwarding headers by default", () => {
    expect(resolveLocalAppRequestSource(new Headers({
      "x-forwarded-for": "203.0.113.20",
      "x-real-ip": "203.0.113.21"
    }), false)).toBe(UNATTRIBUTED_LOCAL_APP_SOURCE);
  });

  it("accepts one canonical address only from a trusted ingress", () => {
    expect(resolveLocalAppRequestSource(new Headers({
      "x-forwarded-for": " 2001:DB8::1 ",
      "x-real-ip": "2001:db8::1"
    }), true)).toBe("2001:db8::1");
  });

  it.each([
    new Headers(),
    new Headers({ "x-forwarded-for": "192.0.2.1, 10.0.0.1" }),
    new Headers({ "x-real-ip": "not-an-ip" }),
    new Headers({ "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.2" })
  ])("uses the shared unattributed bucket for missing or unsafe trusted headers", (headers) => {
    expect(resolveLocalAppRequestSource(headers, true)).toBe(UNATTRIBUTED_LOCAL_APP_SOURCE);
  });
});
