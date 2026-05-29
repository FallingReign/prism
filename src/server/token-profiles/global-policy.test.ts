import { describe, expect, it } from "vitest";

import { buildTokenProfilePolicy } from "./presets";
import {
  applyGlobalTokenProfilePolicyDefaults,
  buildCurrentGlobalTokenProfilePolicy,
  classifyGlobalTokenProfilePolicyStatus,
  parseGlobalTokenProfilePolicy,
  validateRequestedTokenProfilePolicy
} from "./global-policy";

const now = new Date("2026-01-01T00:00:00.000Z");

describe("Global Token profile policy", () => {
  it("seeds from current Token profile behavior without narrowing rollout", () => {
    const policy = buildCurrentGlobalTokenProfilePolicy();

    expect(policy.presets).toEqual({ allowed: ["read_only", "messages_only", "full_slack_bridge", "custom"], default: "read_only" });
    expect(policy.executionIdentities).toEqual({ allowed: ["automatic", "user", "bot", "selectable"], default: "automatic" });
    expect(policy.expiry).toMatchObject({
      allowNoExpiryForReadOnly: true,
      maximumDays: { readOnly: null, nonDestructive: 90, destructive: 30 },
      allowedExperimentTtls: ["24h", "7d"],
      defaultExperimentTtl: null
    });
    expect(policy.mutation).toEqual({ broadeningRequiresRotation: true, narrowingAppliesImmediately: true, maxRotationOverlap: "24h" });

    const currentMaximum = buildTokenProfilePolicy({ preset: "full_slack_bridge", executionIdentity: "selectable", destructive: true }, now);
    expect(policy.capabilities.maximum).toEqual({
      actions: currentMaximum.capabilityMap.actions,
      surfaces: currentMaximum.capabilityMap.surfaces
    });
  });

  it("applies safe defaults only when optional create/update fields are omitted", () => {
    const policy = buildCurrentGlobalTokenProfilePolicy({
      presets: { allowed: ["read_only", "messages_only"], default: "messages_only" },
      executionIdentities: { allowed: ["automatic", "user"], default: "user" },
      expiry: { defaultExperimentTtl: "24h" }
    });

    expect(
      applyGlobalTokenProfilePolicyDefaults(
        {
          name: "CLI",
          intendedUse: "Post messages",
          preset: "" as never,
          executionIdentity: "" as never
        },
        policy
      )
    ).toMatchObject({ preset: "messages_only", executionIdentity: "user", experiment: "24h" });

    expect(
      applyGlobalTokenProfilePolicyDefaults(
        {
          name: "CLI",
          intendedUse: "Post messages",
          preset: "unsupported" as never,
          executionIdentity: "selectable"
        },
        policy
      )
    ).toMatchObject({ preset: "unsupported", executionIdentity: "selectable" });
  });

  it("rejects requested Token profile policy that exceeds deployment maximums with safe reason codes", () => {
    const policy = buildCurrentGlobalTokenProfilePolicy({
      presets: { allowed: ["read_only"], default: "read_only" },
      executionIdentities: { allowed: ["automatic"], default: "automatic" },
      capabilities: {
        maximum: {
          actions: { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false },
          surfaces: {
            publicChannels: true,
            privateChannels: true,
            directMessages: true,
            groupDirectMessages: true,
            search: true,
            filesMetadata: false,
            canvases: false,
            lists: false,
            future: false
          }
        }
      }
    });
    const requested = buildTokenProfilePolicy({ preset: "messages_only", executionIdentity: "selectable" }, now);

    expect(
      validateRequestedTokenProfilePolicy({
        input: { preset: "messages_only", executionIdentity: "selectable" },
        capabilityMap: requested.capabilityMap,
        expiresAt: requested.expiresAt,
        policyEffectiveAt: now,
        policy
      })
    ).toEqual({
      kind: "blocked",
      code: "global_policy_violation",
      message: "Requested Token profile policy exceeds the Global Token profile policy.",
      reasons: [
        { code: "preset_disallowed", message: "The preset is not allowed by the Global Token profile policy." },
        { code: "execution_identity_disallowed", message: "The execution identity is not allowed by the Global Token profile policy." },
        { code: "action_write_messages_exceeds_maximum", message: "The write messages capability exceeds the Global Token profile policy maximum." },
        { code: "action_reactions_exceeds_maximum", message: "The reactions capability exceeds the Global Token profile policy maximum." }
      ]
    });
  });

  it("classifies existing profiles outside a newer maximum without secret-bearing details", () => {
    const policy = buildCurrentGlobalTokenProfilePolicy({
      capabilities: {
        maximum: {
          actions: { read: true, search: true, writeMessages: true, reactions: true, filesMetadata: false, destructive: false },
          surfaces: {
            publicChannels: true,
            privateChannels: true,
            directMessages: true,
            groupDirectMessages: true,
            search: true,
            filesMetadata: false,
            canvases: false,
            lists: false,
            future: false
          }
        }
      },
      expiry: { maximumDays: { readOnly: null, nonDestructive: 30, destructive: 7 }, allowedExperimentTtls: ["24h"] }
    });
    const profilePolicy = buildTokenProfilePolicy({ preset: "full_slack_bridge", executionIdentity: "automatic", destructive: true, experiment: "7d" }, now);

    const status = classifyGlobalTokenProfilePolicyStatus(
      {
        preset: "full_slack_bridge",
        capabilityMap: profilePolicy.capabilityMap,
        expiresAt: profilePolicy.expiresAt,
        policyEffectiveAt: now
      },
      policy
    );

    expect(status).toEqual({
      kind: "outside",
      reasons: [
        { code: "action_files_metadata_exceeds_maximum", message: "The files metadata capability exceeds the Global Token profile policy maximum." },
        { code: "action_destructive_exceeds_maximum", message: "The destructive capability exceeds the Global Token profile policy maximum." },
        { code: "surface_files_metadata_exceeds_maximum", message: "The files metadata surface exceeds the Global Token profile policy maximum." },
        { code: "experiment_ttl_disallowed", message: "The experiment TTL is not allowed by the Global Token profile policy." }
      ]
    });
    expect(JSON.stringify(status)).not.toMatch(/prism_dev_|tokenHash|pepper|xox[bp]-|access_token|refresh_token/i);
  });

  it("accepts only the typed policy schema and excludes non-goal settings", () => {
    const parsed = parseGlobalTokenProfilePolicy({
      ...buildCurrentGlobalTokenProfilePolicy(),
      slackScopes: ["channels:history"],
      rateLimits: { perMinute: 100 },
      auditRetentionDays: 365
    });

    expect(parsed).toEqual({ kind: "invalid", message: "Global Token profile policy contains unsupported fields." });
  });
});
