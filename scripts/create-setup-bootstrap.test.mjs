import { describe, expect, it, vi } from "vitest";

import { formatBootstrapSuccess, parseBootstrapArguments } from "./create-setup-bootstrap.mjs";

describe("setup bootstrap command", () => {
  it("requires recovery to be an explicit argument", () => {
    expect(parseBootstrapArguments([])).toEqual({ recovery: false });
    expect(parseBootstrapArguments(["--recover"])).toEqual({ recovery: true });
    expect(() => parseBootstrapArguments(["--recovery"])).toThrow("setup_bootstrap_usage");
    expect(() => parseBootstrapArguments(["--recover", "extra"])).toThrow("setup_bootstrap_usage");
  });

  it("prints the plaintext capability exactly once and never creates a tokenized URL", () => {
    const code = "setup-code-canary";
    const lines = formatBootstrapSuccess({
      code,
      expiresAt: new Date("2026-08-23T01:15:00.000Z"),
      recovery: false
    });

    expect(lines.filter((line) => line === code)).toHaveLength(1);
    expect(lines.join("\n").match(new RegExp(code, "g"))).toHaveLength(1);
    expect(lines.join("\n")).not.toMatch(/[?&#](code|token|capability)=/i);
  });
});
