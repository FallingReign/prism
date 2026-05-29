import { describe, expect, it } from "vitest";

import { buildTokenProfilePolicy } from "../src/server/token-profiles/presets";
import type { TokenProfileMetadata } from "../src/server/token-profiles/service";
import { toTokenProfileSummary } from "./token-profile-summary";

describe("Token profile website summary", () => {
  it("projects persisted capability actions into a narrow client-safe DTO", () => {
    const policy = buildTokenProfilePolicy({
      preset: "custom",
      executionIdentity: "automatic",
      custom: { read: true, search: false, writeMessages: true, reactions: false, filesMetadata: false, destructive: false }
    });

    expect(toTokenProfileSummary(metadataFixture(policy.capabilityMap)).capabilities).toEqual({
      read: true,
      search: false,
      writeMessages: true,
      reactions: false,
      filesMetadata: false,
      destructive: false
    });
  });
});

function metadataFixture(capabilityMap: TokenProfileMetadata["capabilityMap"]): TokenProfileMetadata {
  return {
    id: "profile_1",
    prismUserId: "prism_user_1",
    slackConnectionId: "slack_connection_1",
    name: "Local MCP custom",
    nameNormalized: "local mcp custom",
    intendedUse: "Read and post through Prism",
    preset: "custom",
    capabilityMap,
    expiresAt: null,
    status: "active",
    globalPolicyStatus: { kind: "inside", reasons: [] },
    policyEffectiveAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  };
}
