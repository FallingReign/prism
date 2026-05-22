import { describe, expect, it } from "vitest";

import { buildTokenProfilePolicy } from "./presets";
import { getPrismCapabilities, type LocalToolTokenStore, type ResolvedDeveloperToken } from "./local-tool-status";

const now = new Date("2026-01-01T00:00:00.000Z");

function record(resolved: ResolvedDeveloperToken): LocalToolTokenStore {
  return {
    async resolveDeveloperToken() {
      return resolved;
    }
  };
}

describe("Local-tool Prism capability discovery", () => {
  it("derives read-only method availability from the effective Token profile policy", async () => {
    const policy = buildTokenProfilePolicy({ preset: "read_only", executionIdentity: "automatic" }, now);
    const result = await getPrismCapabilities({
      store: record({
        tokenProfileId: "profile_read",
        tokenExpiresAt: null,
        tokenRevokedAt: null,
        profileStatus: "active",
        profileExpiresAt: null,
        preset: "read_only",
        capabilityMap: policy.capabilityMap,
        slackStatus: "healthy",
        slackLastErrorClass: null,
        hasUserCredential: true,
        hasBotCredential: true
      }),
      bearerToken: "prism_dev_readonlycanaryreadonlycanaryreadonly",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      requestId: "req_capabilities",
      now
    });

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      requestId: "req_capabilities",
      token: { status: "active", tokenProfileId: "profile_read" },
      capabilityMap: {
        preset: "read_only",
        actions: { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false }
      },
      categories: {
        "conversations.read": { allowed: true },
        search: { allowed: true },
        "messages.write": { allowed: false }
      },
      methods: {
        "conversations.history": { status: "allowed" },
        "chat.postMessage": { status: "denied" },
        "admin.users.list": { status: "unsupported" }
      }
    });
    expect(result.body.unsupported.surfaces).toEqual(expect.arrayContaining(["admin", "events", "fileTransfer", "canvases", "lists"]));
    expect(JSON.stringify(result.body)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary|xox[bp]-|refresh|access_token|client_secret/i);
  });

  it("projects write, reaction, file metadata, and destructive method states from stronger profiles", async () => {
    const messages = buildTokenProfilePolicy({ preset: "messages_only", executionIdentity: "user" }, now);
    const destructive = buildTokenProfilePolicy(
      {
        preset: "custom",
        executionIdentity: "selectable",
        custom: { read: true, search: true, writeMessages: true, reactions: true, filesMetadata: true, destructive: true }
      },
      now
    );

    const messagesResult = await getPrismCapabilities({
      store: record({
        tokenProfileId: "profile_messages",
        tokenExpiresAt: messages.expiresAt,
        tokenRevokedAt: null,
        profileStatus: "active",
        profileExpiresAt: messages.expiresAt,
        preset: "messages_only",
        capabilityMap: messages.capabilityMap,
        slackStatus: "healthy",
        slackLastErrorClass: null,
        hasUserCredential: true,
        hasBotCredential: true
      }),
      bearerToken: "prism_dev_messagescanarymessagescanarymessages",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      requestId: "req_messages",
      now
    });
    const destructiveResult = await getPrismCapabilities({
      store: record({
        tokenProfileId: "profile_destructive",
        tokenExpiresAt: destructive.expiresAt,
        tokenRevokedAt: null,
        profileStatus: "active",
        profileExpiresAt: destructive.expiresAt,
        preset: "custom",
        capabilityMap: destructive.capabilityMap,
        slackStatus: "healthy",
        slackLastErrorClass: null,
        hasUserCredential: true,
        hasBotCredential: true
      }),
      bearerToken: "prism_dev_destructivecanarydestructivecanary",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      requestId: "req_destructive",
      now
    });

    expect(messagesResult.body.methods?.["chat.postMessage"]).toMatchObject({ status: "allowed" });
    expect(messagesResult.body.methods?.["reactions.add"]).toMatchObject({ status: "allowed" });
    expect(messagesResult.body.methods?.["search.messages"]).toMatchObject({ status: "denied" });
    expect(messagesResult.body.methods?.["files.info"]).toMatchObject({ status: "denied" });
    expect(messagesResult.body.methods?.["chat.delete"]).toMatchObject({ status: "denied" });

    expect(destructiveResult.body.methods?.["chat.delete"]).toMatchObject({ status: "allowed" });
    expect(destructiveResult.body.methods?.["files.info"]).toMatchObject({ status: "allowed" });
    expect(destructiveResult.body.executionIdentity).toMatchObject({ configured: "selectable", available: true });
  });
});
