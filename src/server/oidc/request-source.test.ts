import { describe, expect, it } from "vitest";

import {
  resolveOidcAuthorizationSource,
  UNATTRIBUTED_OIDC_SOURCE
} from "./request-source";

describe("OIDC authorization request source", () => {
  it("never trusts forwarding headers unless trusted ingress handling is explicit", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.20",
      "x-real-ip": "203.0.113.21"
    });
    expect(resolveOidcAuthorizationSource(headers, false)).toBe(UNATTRIBUTED_OIDC_SOURCE);
  });

  it("uses one normalized address only when trusted proxy headers are enabled", () => {
    expect(resolveOidcAuthorizationSource(
      new Headers({ "x-forwarded-for": "2001:DB8::1, 10.0.0.1" }),
      true
    )).toBe("2001:db8::1");
    expect(resolveOidcAuthorizationSource(
      new Headers({ "x-forwarded-for": "spoofed", "x-real-ip": "192.0.2.42" }),
      true
    )).toBe("192.0.2.42");
    expect(resolveOidcAuthorizationSource(
      new Headers({ "x-forwarded-for": "not-an-ip" }),
      true
    )).toBe(UNATTRIBUTED_OIDC_SOURCE);
  });
});
