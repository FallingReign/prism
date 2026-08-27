import { describe, expect, it } from "vitest";

import { PLAYTEST_APP_CAPABILITY_MAP, PLAYTEST_APP_PROFILE_NAME } from "../token-profiles/first-party-app";
import type { ResolvedDeveloperToken } from "../token-profiles/local-tool-status";
import { authenticatePlaytestDirectory } from "./authentication";
import { PLAYTEST_SLACK_DIRECTORY_READ_POLICY } from "./policy";

describe("Playtest directory authentication", () => {
  it("accepts only the active first-party Playtest credential", async () => {
    const result = await authenticatePlaytestDirectory({
      store: { resolveDeveloperToken: async () => resolvedToken() },
      authorization: "Bearer prism_dev_0123456789abcdefghijklmnopqrstuvwxyz",
      requestId: "request-1",
      developerTokenConfig: { pepper: "test-pepper", pepperId: "test" }
    });
    expect(result).toEqual({
      kind: "authenticated",
      identity: { prismUserId: "user_1", tokenProfileId: "profile_1", slackConnectionId: "conn_1" }
    });
  });

  it("rejects a valid general Prism token instead of widening the directory", async () => {
    const result = await authenticatePlaytestDirectory({
      store: { resolveDeveloperToken: async () => resolvedToken({ clientId: null, tokenProfileName: "General MCP" }) },
      authorization: "Bearer prism_dev_0123456789abcdefghijklmnopqrstuvwxyz",
      requestId: "request-2",
      developerTokenConfig: { pepper: "test-pepper", pepperId: "test" }
    });
    expect(result).toEqual({ kind: "denied", status: 403, error: "playtest_directory_not_allowed" });
  });

  it("uses a versioned, connection-bound first-party directory policy", () => {
    expect(PLAYTEST_SLACK_DIRECTORY_READ_POLICY).toEqual({
      version: 1,
      capability: "playtest.slack.directory.read",
      clientId: "shg-playtest",
      tokenProfileName: PLAYTEST_APP_PROFILE_NAME,
      connectionBinding: "issued_slack_connection",
      requiredCredential: "user"
    });
  });
});

function resolvedToken(overrides: Partial<ResolvedDeveloperToken> = {}): ResolvedDeveloperToken {
  return {
    prismUserId: "user_1",
    developerTokenId: "token_1",
    tokenProfileId: "profile_1",
    tokenProfileName: PLAYTEST_APP_PROFILE_NAME,
    clientId: "shg-playtest",
    slackConnectionId: "conn_1",
    tokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    tokenRevokedAt: null,
    profileStatus: "active",
    profileExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    preset: "custom",
    capabilityMap: PLAYTEST_APP_CAPABILITY_MAP,
    slackStatus: "healthy",
    slackLastErrorClass: null,
    hasUserCredential: true,
    hasBotCredential: true,
    slackTeamId: "T111",
    slackEnterpriseId: null,
    slackUserId: "U111",
    ...overrides
  };
}
