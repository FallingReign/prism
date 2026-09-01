import { describe, expect, it } from "vitest";

import { canonicalUserCode, parseBeginInput, parseTokenInput } from "./validation";

describe("generic local-app authorization validation", () => {
  const begin = {
    clientId: "example-local-app",
    displayName: "Example Local App",
    intendedUse: "Read and reply to Slack messages for my local workflow",
    requestedPreset: "messages_only",
    executionIdentity: "user"
  };

  it("accepts only the exact bounded fixed-policy begin body", () => {
    expect(parseBeginInput(begin)).toEqual(begin);
    expect(parseBeginInput({ ...begin, executionIdentity: "bot" })).toBeNull();
    expect(parseBeginInput({ ...begin, requestedPreset: "full_slack_bridge" })).toBeNull();
    expect(parseBeginInput({ ...begin, extra: true })).toBeNull();
    expect(parseBeginInput({ ...begin, displayName: "bad\nname" })).toBeNull();
    expect(parseBeginInput({ ...begin, clientId: "shg-playtest" })).toBeNull();
  });

  it("accepts only an exact client and high-entropy device code token body", () => {
    const input = { clientId: "example-local-app", deviceCode: "A".repeat(43) };
    expect(parseTokenInput(input)).toEqual(input);
    expect(parseTokenInput({ ...input, deviceCode: "short" })).toBeNull();
    expect(parseTokenInput({ ...input, tokenProfileId: "caller-selected" })).toBeNull();
  });

  it("canonicalizes an ambiguity-free human code", () => {
    expect(canonicalUserCode(" abcd-efgh ")).toBe("ABCD-EFGH");
    expect(canonicalUserCode("ABCI-EFGH")).toBeNull();
    expect(canonicalUserCode("ABCO-EFGH")).toBeNull();
  });
});
