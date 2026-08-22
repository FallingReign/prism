import { describe, expect, it } from "vitest";

import {
  ALL_PRISM_SUPPORTED_SLACK_SCOPES,
  DEFAULT_SLACK_SCOPE_SELECTION,
  SLACK_SCOPE_CATALOG,
  SlackAppConfigurationValidationError,
  canonicalizeSlackScopeSelection,
  redactSlackAppConfiguration,
  selectAllPrismSupportedSlackScopes,
  validateSlackAppConfigurationInput
} from "./app-configuration";

describe("Slack app configuration", () => {
  it("uses every reviewed Prism-supported scope when no selection is supplied", () => {
    expect(canonicalizeSlackScopeSelection()).toEqual(DEFAULT_SLACK_SCOPE_SELECTION);
    expect(DEFAULT_SLACK_SCOPE_SELECTION).toEqual(ALL_PRISM_SUPPORTED_SLACK_SCOPES);
    expect(DEFAULT_SLACK_SCOPE_SELECTION.botScopes).toHaveLength(13);
    expect(DEFAULT_SLACK_SCOPE_SELECTION.userScopes).toHaveLength(14);
    expect(JSON.stringify(DEFAULT_SLACK_SCOPE_SELECTION)).not.toContain("*");
    expect(SLACK_SCOPE_CATALOG.every((scope) => scope.defaultSelected)).toBe(true);
  });

  it("selects the exact reviewed Prism catalogue without a wildcard", () => {
    const selected = selectAllPrismSupportedSlackScopes();
    expect(selected).toEqual(ALL_PRISM_SUPPORTED_SLACK_SCOPES);
    expect(selected.botScopes).toHaveLength(13);
    expect(selected.userScopes).toHaveLength(14);
    expect(JSON.stringify(selected)).not.toContain("*");
  });

  it("canonicalizes and deduplicates by the server-owned catalogue order", () => {
    expect(
      canonicalizeSlackScopeSelection({
        botScopes: ["users:read", "channels:read", "users:read"],
        userScopes: ["chat:write", "channels:history", "chat:write"]
      })
    ).toEqual({
      botScopes: ["channels:read", "users:read"],
      userScopes: ["channels:history", "chat:write"]
    });
  });

  it("rejects unknown scopes and never echoes submitted canaries", () => {
    for (const selection of [
      { botScopes: ["admin.secret-canary"], userScopes: ["chat:write"] },
      { botScopes: [], userScopes: ["chat:write", "unknown-secret-canary"] },
      { botScopes: ["chat:write"], userScopes: [] }
    ]) {
      try {
        canonicalizeSlackScopeSelection(selection);
        throw new Error("expected scope validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(SlackAppConfigurationValidationError);
        expect(String(error)).not.toContain("secret-canary");
      }
    }
  });

  it("validates bounded credentials without trimming or returning the secret", () => {
    const secret = "client-secret-canary";
    const configuration = validateSlackAppConfigurationInput({
      clientId: " 123.456 ",
      clientSecret: secret
    });
    expect(configuration).toEqual({
      clientId: "123.456",
      clientSecret: secret,
      botScopes: ALL_PRISM_SUPPORTED_SLACK_SCOPES.botScopes,
      userScopes: ALL_PRISM_SUPPORTED_SLACK_SCOPES.userScopes
    });

    const redacted = redactSlackAppConfiguration({
      id: "configuration-id",
      version: "7",
      status: "pending",
      clientId: configuration.clientId,
      botScopes: configuration.botScopes,
      userScopes: configuration.userScopes,
      createdVia: "bootstrap",
      createdByPrismUserId: null,
      setupSessionId: "setup-session-id",
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
      activatedAt: null,
      supersededAt: null,
      secretConfigured: true
    });
    expect(redacted.secretConfigured).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(redacted)).not.toContain("envelope");
  });

  it("rejects unsafe production fixtures and invalid secrets generically", () => {
    for (const input of [
      { clientId: "mock-playtest-client", clientSecret: "secret" },
      { clientId: "replace-with-client", clientSecret: "secret" },
      { clientId: "real-client", clientSecret: "secret\ncanary" },
      { clientId: "real-client", clientSecret: "" }
    ]) {
      try {
        validateSlackAppConfigurationInput(input, { production: true });
        throw new Error("expected credential validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(SlackAppConfigurationValidationError);
        if (input.clientSecret) expect(String(error)).not.toContain(input.clientSecret);
        expect(String(error)).not.toContain(input.clientId);
      }
    }
  });
});
