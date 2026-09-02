import { describe, expect, it } from "vitest";

import { buildTokenProfilePolicy } from "./presets";

const now = new Date("2026-01-01T00:00:00.000Z");

describe("Token profile presets", () => {
  it("encodes PRD capability and expiry defaults without enabling destructive actions by default", () => {
    const readOnly = buildTokenProfilePolicy({ preset: "read_only", executionIdentity: "automatic" }, now);
    const messages = buildTokenProfilePolicy({ preset: "messages_only", executionIdentity: "user" }, now);
    const fullBridge = buildTokenProfilePolicy({ preset: "full_slack_bridge", executionIdentity: "selectable" }, now);
    const fullWebApi = buildTokenProfilePolicy({ preset: "full_web_api", executionIdentity: "user" }, now);
    const destructiveCustom = buildTokenProfilePolicy(
      { preset: "custom", executionIdentity: "bot", custom: { read: true, search: true, writeMessages: true, destructive: true } },
      now
    );
    const experiment = buildTokenProfilePolicy({ preset: "custom", executionIdentity: "automatic", experiment: "24h" }, now);

    expect(readOnly.expiresAt).toBeNull();
    expect(readOnly.capabilityMap.actions).toMatchObject({ read: true, search: true, writeMessages: false, reactions: false, destructive: false });

    expect(messages.expiresAt).toBeNull();
    expect(messages.capabilityMap.actions).toMatchObject({ read: true, writeMessages: true, reactions: true, filesMetadata: false, destructive: false });
    expect(messages.capabilityMap.deferred.fileTransfer).toBe(false);

    expect(fullBridge.expiresAt).toBeNull();
    expect(fullBridge.capabilityMap.actions.destructive).toBe(false);
    expect(fullBridge.capabilityMap.mutation.destructiveOptIn).toBe(false);

    expect(fullWebApi.expiresAt?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(fullWebApi.capabilityMap.webApi).toEqual({ mode: "all_methods" });
    expect(fullWebApi.capabilityMap.inbound).toEqual({ blockActions: false, events: false, slashCommands: false });

    expect(messages.capabilityMap.webApi).toEqual({ mode: "curated" });
    expect(messages.capabilityMap.inbound).toEqual({ blockActions: false, events: false, slashCommands: false });

    expect(destructiveCustom.expiresAt?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(destructiveCustom.capabilityMap.actions.destructive).toBe(true);
    expect(destructiveCustom.capabilityMap.executionIdentity).toBe("bot");
    expect(destructiveCustom.capabilityMap.mutation).toMatchObject({
      destructiveOptIn: true,
      narrowingAppliesImmediately: true,
      broadeningRequiresRotation: true
    });

    expect(experiment.expiresAt?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(experiment.capabilityMap.experiment).toEqual({ enabled: true, ttl: "24h" });
  });
});
