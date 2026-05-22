import { describe, expect, it } from "vitest";

import { hashDeveloperToken, issueDeveloperToken, verifyDeveloperToken } from "./developer-token";

describe("Prism developer tokens", () => {
  it("issues opaque high-entropy tokens and stores only keyed verifier material", () => {
    const token = issueDeveloperToken({ randomBytes: () => Buffer.alloc(32, 7) });
    const verifier = hashDeveloperToken(token, { pepper: "server-held-pepper-canary", pepperId: "local-pepper" });

    expect(token).toMatch(/^prism_dev_[A-Za-z0-9_-]+$/);
    expect(token).not.toContain(".");
    expect(Buffer.from(token.replace(/^prism_dev_/, ""), "base64url")).toHaveLength(32);
    expect(verifier).toMatchObject({ algorithm: "hmac-sha256", pepperId: "local-pepper" });
    expect(verifier.tokenHash).not.toContain(token);
    expect(verifier.tokenHash).not.toContain("server-held-pepper-canary");
    expect(verifyDeveloperToken(token, verifier, { pepper: "server-held-pepper-canary", pepperId: "local-pepper" })).toBe(true);
    expect(verifyDeveloperToken(`${token}wrong`, verifier, { pepper: "server-held-pepper-canary", pepperId: "local-pepper" })).toBe(false);
  });
});
