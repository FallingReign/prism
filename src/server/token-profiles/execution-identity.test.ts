import { describe, expect, it } from "vitest";

import { evaluateSlackMethodPolicy, type SlackMethodPolicyStore } from "./method-policy";
import { resolveSlackExecutionIdentity } from "./execution-identity";
import { buildTokenProfilePolicy } from "./presets";
import type { ResolvedDeveloperToken } from "./local-tool-status";

const now = new Date("2026-01-01T00:00:00.000Z");

function resolved(profile: ReturnType<typeof buildTokenProfilePolicy>, overrides: Partial<ResolvedDeveloperToken> = {}): ResolvedDeveloperToken {
  return {
    tokenProfileId: "profile_1",
    slackConnectionId: "conn_1",
    tokenExpiresAt: profile.expiresAt,
    tokenRevokedAt: null,
    profileStatus: "active",
    profileExpiresAt: profile.expiresAt,
    preset: profile.capabilityMap.preset,
    capabilityMap: profile.capabilityMap,
    slackStatus: "healthy",
    slackLastErrorClass: null,
    hasUserCredential: true,
    hasBotCredential: true,
    slackTeamId: "T123",
    ...overrides
  };
}

function store(row: ResolvedDeveloperToken | null): SlackMethodPolicyStore {
  return {
    async resolveDeveloperToken() {
      return row;
    }
  };
}

async function allowedDecision(row: ResolvedDeveloperToken, method: string, surface = "public_channel") {
  const decision = await evaluateSlackMethodPolicy({
    store: store(row),
    bearerToken: "prism_dev_identityresolutioncanaryidentity",
    developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
    method,
    requestId: "req_policy",
    requestContext: { workspaceId: "T123", surface: surface as never },
    now
  });
  expect(decision.kind).toBe("allowed");
  return decision;
}

describe("Slack execution identity resolution", () => {
  it("resolves automatic message writes to the existing bot credential without exposing secrets", async () => {
    const profile = buildTokenProfilePolicy({ preset: "full_slack_bridge", executionIdentity: "automatic" }, now);
    const decision = await allowedDecision(resolved(profile), "chat.postMessage");

    const identity = resolveSlackExecutionIdentity({ decision, executionModeHeader: null, requestId: "req_identity" });

    expect(identity).toMatchObject({
      kind: "resolved",
      tokenProfileId: "profile_1",
      slackConnectionId: "conn_1",
      executionMode: "bot",
      requestedMode: null
    });
    expect(JSON.stringify(identity)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary|xox[bp]-|refresh|access_token|client_secret/i);
  });

  it("honors selectable execution-mode headers and fails closed for invalid or non-selectable overrides", async () => {
    const selectable = buildTokenProfilePolicy({ preset: "full_slack_bridge", executionIdentity: "selectable" }, now);
    const automatic = buildTokenProfilePolicy({ preset: "full_slack_bridge", executionIdentity: "automatic" }, now);
    const selectableDecision = await allowedDecision(resolved(selectable), "conversations.history");
    const automaticDecision = await allowedDecision(resolved(automatic), "conversations.history");

    const requestedUser = resolveSlackExecutionIdentity({ decision: selectableDecision, executionModeHeader: "user", requestId: "req_user" });
    const requestedBot = resolveSlackExecutionIdentity({ decision: selectableDecision, executionModeHeader: "BOT", requestId: "req_bot" });
    const requestedAuto = resolveSlackExecutionIdentity({ decision: selectableDecision, executionModeHeader: "auto", requestId: "req_auto" });
    const invalid = resolveSlackExecutionIdentity({ decision: selectableDecision, executionModeHeader: "workspace-admin", requestId: "req_invalid" });
    const nonSelectableOverride = resolveSlackExecutionIdentity({ decision: automaticDecision, executionModeHeader: "bot", requestId: "req_non_selectable" });

    expect(requestedUser).toMatchObject({ kind: "resolved", executionMode: "user", requestedMode: "user" });
    expect(requestedBot).toMatchObject({ kind: "resolved", executionMode: "bot", requestedMode: "bot" });
    expect(requestedAuto).toMatchObject({ kind: "resolved", executionMode: "user", requestedMode: "auto" });
    expect(invalid).toMatchObject({ kind: "denied", body: { ok: false, error: "not_allowed", prism: { errorClass: "invalid_execution_mode" } } });
    expect(nonSelectableOverride).toMatchObject({ kind: "denied", body: { ok: false, error: "not_allowed", prism: { errorClass: "execution_mode_not_selectable" } } });
  });

  it("resolves configured user-backed and bot-backed profiles to their concrete credential kind", async () => {
    const user = buildTokenProfilePolicy({ preset: "read_only", executionIdentity: "user" }, now);
    const bot = buildTokenProfilePolicy({ preset: "messages_only", executionIdentity: "bot" }, now);
    const userDecision = await allowedDecision(resolved(user), "conversations.history");
    const botDecision = await allowedDecision(resolved(bot), "chat.postMessage");

    expect(resolveSlackExecutionIdentity({ decision: userDecision, executionModeHeader: null, requestId: "req_user_configured" })).toMatchObject({
      kind: "resolved",
      executionMode: "user",
      requestedMode: null
    });
    expect(resolveSlackExecutionIdentity({ decision: botDecision, executionModeHeader: null, requestId: "req_bot_configured" })).toMatchObject({
      kind: "resolved",
      executionMode: "bot",
      requestedMode: null
    });
  });

  it("uses deterministic automatic preferences with single-credential fallback and no membership side effects", async () => {
    const automatic = buildTokenProfilePolicy({ preset: "full_slack_bridge", executionIdentity: "automatic" }, now);
    const read = await allowedDecision(resolved(automatic), "conversations.history");
    const writeWithOnlyUser = await allowedDecision(resolved(automatic, { hasBotCredential: false }), "chat.postMessage");
    const readWithOnlyBot = await allowedDecision(resolved(automatic, { hasUserCredential: false }), "conversations.history");

    expect(resolveSlackExecutionIdentity({ decision: read, executionModeHeader: null, requestId: "req_read" })).toMatchObject({
      kind: "resolved",
      executionMode: "user"
    });
    expect(resolveSlackExecutionIdentity({ decision: writeWithOnlyUser, executionModeHeader: null, requestId: "req_write_user" })).toMatchObject({
      kind: "resolved",
      executionMode: "user"
    });
    expect(resolveSlackExecutionIdentity({ decision: readWithOnlyBot, executionModeHeader: null, requestId: "req_read_bot" })).toMatchObject({
      kind: "resolved",
      executionMode: "bot"
    });
  });
});
