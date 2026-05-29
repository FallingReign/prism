import { describe, expect, it } from "vitest";

import { buildCreateTokenProfileModalRequestBody, buildCreateTokenProfileRequestBody, buildPolicyUpdateRequestBody } from "./token-profile-form";

describe("Token profile form request bodies", () => {
  it("preserves the existing create payload shape for custom access and destructive opt-in", () => {
    const form = new FormData();
    form.set("name", "Local MCP write");
    form.set("intendedUse", "Post release notes from my local MCP server");
    form.set("preset", "custom");
    form.set("executionIdentity", "user");
    form.set("customRead", "on");
    form.set("customWriteMessages", "on");
    form.set("customReactions", "on");
    form.set("destructive", "on");
    form.set("experiment", "7d");

    expect(buildCreateTokenProfileRequestBody(form)).toEqual({
      name: "Local MCP write",
      intendedUse: "Post release notes from my local MCP server",
      preset: "custom",
      executionIdentity: "user",
      destructive: true,
      experiment: "7d",
      custom: {
        read: true,
        search: false,
        writeMessages: true,
        reactions: true,
        filesMetadata: false,
        destructive: true
      }
    });

  });

  it("uses safe defaults for the focused create modal payload", () => {
    const form = new FormData();
    form.set("name", "Local MCP read");
    form.set("intendedUse", "Read Slack context locally");
    form.set("preset", "read_only");
    form.set("customRead", "on");
    form.set("customSearch", "on");

    expect(buildCreateTokenProfileModalRequestBody(form)).toEqual({
      name: "Local MCP read",
      intendedUse: "Read Slack context locally",
      preset: "read_only",
      executionIdentity: "automatic",
      destructive: false
    });
  });

  it("serializes visible create modal custom checkboxes when manual edits select Custom", () => {
    const form = new FormData();
    form.set("name", "Local MCP custom");
    form.set("intendedUse", "Read Slack and add lightweight reactions");
    form.set("preset", "custom");
    form.set("customRead", "on");
    form.set("customReactions", "on");

    expect(buildCreateTokenProfileModalRequestBody(form)).toEqual({
      name: "Local MCP custom",
      intendedUse: "Read Slack and add lightweight reactions",
      preset: "custom",
      executionIdentity: "automatic",
      destructive: false,
      custom: {
        read: true,
        search: false,
        writeMessages: false,
        reactions: true,
        filesMetadata: false,
        destructive: false
      }
    });
  });

  it("preserves policy update profile identity while sending broadening confirmation", () => {
    const form = new FormData();
    form.set("policyPreset", "full_slack_bridge");
    form.set("policyExecutionIdentity", "selectable");
    form.set("policyExperiment", "24h");
    form.set("confirmBroadening", "on");

    expect(
      buildPolicyUpdateRequestBody(form, {
        id: "profile_1",
        name: "Release notes agent",
        intendedUse: "Post release notes",
        preset: "messages_only",
        executionIdentity: "user",
        expiresAt: null,
        createdAt: "2026-01-01T00:00:00.000Z"
      })
    ).toEqual({
      name: "Release notes agent",
      intendedUse: "Post release notes",
      preset: "full_slack_bridge",
      executionIdentity: "selectable",
      destructive: false,
      experiment: "24h",
      confirmBroadening: true
    });
  });

  it("preserves intentional custom policy capabilities when Policy preset is Custom", () => {
    const form = new FormData();
    form.set("policyPreset", "custom");
    form.set("policyExecutionIdentity", "automatic");
    form.set("policyRead", "on");
    form.set("policySearch", "on");
    form.set("policyFilesMetadata", "on");
    form.set("policyDestructive", "on");

    expect(
      buildPolicyUpdateRequestBody(form, {
        id: "profile_1",
        name: "Research agent",
        intendedUse: "Search Slack metadata",
        preset: "read_only",
        executionIdentity: "automatic",
        expiresAt: null,
        createdAt: "2026-01-01T00:00:00.000Z"
      })
    ).toMatchObject({
      preset: "custom",
      destructive: true,
      custom: {
        read: true,
        search: true,
        writeMessages: false,
        reactions: false,
        filesMetadata: true,
        destructive: true
      }
    });
  });
});
