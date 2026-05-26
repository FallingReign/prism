import { describe, expect, it } from "vitest";

import type { TokenProfileSummary } from "./token-profile-summary";
import { accessStatusForProfile, hasUsableDeveloperToken, isInactiveTokenProfile, managerTokenProfiles } from "./token-profile-workspace";

const baseProfile: TokenProfileSummary = {
  id: "profile_1",
  name: "Local MCP read",
  intendedUse: "Read Slack context locally",
  preset: "read_only",
  executionIdentity: "automatic",
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  developerToken: { status: "active" }
};

describe("Token profile workspace presentation", () => {
  it("describes whether a local tool can use Slack through Prism right now", () => {
    expect(accessStatusForProfile(baseProfile, "healthy")).toEqual({ label: "Ready", tone: "success" });
    expect(accessStatusForProfile(baseProfile, "reauth_required")).toEqual({ label: "Needs Slack reauth", tone: "warning" });
    expect(accessStatusForProfile({ ...baseProfile, developerToken: { status: "expired" } }, "healthy")).toEqual({
      label: "Expired",
      tone: "warning"
    });
    expect(accessStatusForProfile({ ...baseProfile, developerToken: { status: "missing" } }, "healthy")).toEqual({
      label: "No active token",
      tone: "warning"
    });
    expect(accessStatusForProfile({ ...baseProfile, developerToken: { status: "revoked" } }, "healthy")).toEqual({
      label: "Removed",
      tone: "neutral"
    });
  });

  it("keeps inactive Token profiles in the manager while identifying usable access", () => {
    const profiles: TokenProfileSummary[] = [
      baseProfile,
      { ...baseProfile, id: "profile_2", name: "Expired agent", developerToken: { status: "expired" } },
      { ...baseProfile, id: "profile_3", name: "Removed agent", developerToken: { status: "revoked" } }
    ];

    expect(managerTokenProfiles(profiles).map((profile) => profile.name)).toEqual(["Local MCP read", "Expired agent", "Removed agent"]);
    expect(profiles.map(isInactiveTokenProfile)).toEqual([false, true, true]);
    expect(profiles.map(hasUsableDeveloperToken)).toEqual([true, false, false]);
  });
});
