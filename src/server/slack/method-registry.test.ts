import { describe, expect, it } from "vitest";

import { buildMethodAvailability, classifySlackMethod } from "./method-registry";
import { buildTokenProfilePolicy } from "../token-profiles/presets";

describe("Slack Method registry discovery", () => {
  it("projects supported, denied, and deferred method availability from a Capability map", () => {
    const discovery = buildMethodAvailability({
      version: 1,
      preset: "read_only",
      workspaces: { mode: "linked_slack_connection" },
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
      },
      actions: {
        read: true,
        search: true,
        writeMessages: false,
        reactions: false,
        filesMetadata: false,
        destructive: false
      },
      executionIdentity: "automatic",
      experiment: { enabled: false, ttl: null },
      mutation: { destructiveOptIn: false, narrowingAppliesImmediately: true, broadeningRequiresRotation: true },
      deferred: {
        admin: false,
        fileTransfer: false,
        events: false,
        slashCommands: false,
        interactivity: false,
        canvases: false,
        lists: false
      }
    });

    expect(discovery.categories["conversations.read"]).toMatchObject({ allowed: true });
    expect(discovery.categories.search).toMatchObject({ allowed: true });
    expect(discovery.categories["messages.write"]).toMatchObject({ allowed: false });
    expect(discovery.methods["conversations.history"]).toMatchObject({ category: "conversations.read", status: "allowed", supported: true });
    expect(discovery.methods["chat.postMessage"]).toMatchObject({ category: "messages.write", status: "denied", requiredCapability: "writeMessages" });
    expect(discovery.methods["chat.delete"]).toMatchObject({ category: "messages.destructive", status: "denied", requiredCapability: "destructive" });
    expect(discovery.methods["admin.users.list"]).toMatchObject({ category: "admin", status: "unsupported", supported: false });
    expect(discovery.unsupported.surfaces).toEqual(
      expect.arrayContaining(["admin", "events", "slashCommands", "interactivity", "fileTransfer", "canvases", "lists"])
    );
  });

  it("classifies representative supported, deferred, admin/organisation, and unknown method families", () => {
    expect(classifySlackMethod("conversations.list")).toMatchObject({ category: "conversations.read", supported: true, requiredCapabilities: ["read"] });
    expect(classifySlackMethod("chat.update")).toMatchObject({ category: "messages.write", supported: true, requiredCapabilities: ["writeMessages"] });
    expect(classifySlackMethod("chat.delete")).toMatchObject({
      category: "messages.destructive",
      supported: true,
      requiredCapabilities: ["writeMessages", "destructive"]
    });
    expect(classifySlackMethod("files.upload")).toMatchObject({ category: "fileTransfer", supported: false, status: "deferred" });
    expect(classifySlackMethod("admin.users.list")).toMatchObject({ category: "admin", supported: false, status: "unsupported" });
    expect(classifySlackMethod("team.info")).toMatchObject({ category: "admin", supported: false, status: "unsupported" });
    expect(classifySlackMethod("unknown.futureMethod")).toMatchObject({ category: "future", supported: false, status: "unsupported" });
  });

  it("reports every known method as allowed for Full Web API discovery", () => {
    const profile = buildTokenProfilePolicy(
      { preset: "full_web_api", executionIdentity: "user" },
      new Date("2026-01-01T00:00:00.000Z")
    );
    const discovery = buildMethodAvailability(profile.capabilityMap);

    expect(discovery.categories["web_api.full"]).toEqual({ allowed: true, methods: ["*"] });
    expect(discovery.methods["chat.postMessage"]).toMatchObject({ category: "web_api.full", status: "allowed", supported: true });
    expect(discovery.methods["views.open"]).toMatchObject({ category: "web_api.full", status: "allowed", supported: true });
    expect(discovery.unsupported.surfaces).toEqual([]);
  });
});
