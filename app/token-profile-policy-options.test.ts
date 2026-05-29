import { describe, expect, it } from "vitest";

import { buildCurrentGlobalTokenProfilePolicy } from "../src/server/token-profiles/global-policy";
import { buildTokenProfilePolicy } from "../src/server/token-profiles/presets";
import { capabilityTemplateForPreset, presetAvailability, tokenProfilePolicyOptionsFromGlobalPolicy } from "./token-profile-policy-options";

describe("Token profile policy UI options", () => {
  it("keeps visible preset templates aligned with server policy actions", () => {
    for (const preset of ["read_only", "messages_only", "full_slack_bridge"] as const) {
      expect(capabilityTemplateForPreset(preset)).toEqual(
        buildTokenProfilePolicy({ preset, executionIdentity: "automatic", destructive: false }).capabilityMap.actions
      );
    }
  });

  it("projects global policy maxima into preset availability without hiding policy-disabled choices", () => {
    const policy = buildCurrentGlobalTokenProfilePolicy({
      capabilities: {
        defaults: buildTokenProfilePolicy({ preset: "read_only", executionIdentity: "automatic" }).capabilityMap,
        maximum: buildTokenProfilePolicy({ preset: "read_only", executionIdentity: "automatic" }).capabilityMap
      }
    });

    const options = tokenProfilePolicyOptionsFromGlobalPolicy(policy);

    expect(presetAvailability("read_only", options)).toEqual({ allowed: true, reason: null });
    expect(presetAvailability("messages_only", options)).toEqual({
      allowed: false,
      reason: "Global policy disables Write messages and Reactions."
    });
    expect(options.capabilities.maximum.writeMessages).toBe(false);
  });
});
