import { describe, expect, it, vi } from "vitest";

import { evaluateSlackMethodPolicy, type SlackMethodPolicyStore } from "./method-policy";
import { buildTokenProfilePolicy } from "./presets";
import type { ResolvedDeveloperToken } from "./local-tool-status";
import { PLAYTEST_APP_CAPABILITY_MAP } from "./first-party-app";

const now = new Date("2026-01-01T00:00:00.000Z");

function resolved(profile: ReturnType<typeof buildTokenProfilePolicy>, overrides: Partial<ResolvedDeveloperToken> = {}): ResolvedDeveloperToken {
  return {
    tokenProfileId: "profile_1",
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

function store(row: ResolvedDeveloperToken | null, workspaceAllowed = true): SlackMethodPolicyStore {
  return {
    async resolveDeveloperToken() {
      return row;
    },
    async isWorkspaceAllowed() {
      return workspaceAllowed;
    }
  };
}

describe("Slack method policy enforcement", () => {
  it("allows Playtest chat.postMessage and denies unrelated reads, reactions, and destructive methods", async () => {
    const app = resolved(
      { capabilityMap: PLAYTEST_APP_CAPABILITY_MAP, expiresAt: null },
      { prismUserId: "prism-user-1", clientId: "shg-playtest", hasBotCredential: false }
    );
    const decide = (method: string) => evaluateSlackMethodPolicy({
      store: store(app),
      bearerToken: "prism_dev_playtestpolicycanaryplaytestpolicy",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method,
      requestId: `req_${method}`,
      requestContext: { workspaceId: "T123", surface: "public_channel" },
      now
    });

    await expect(decide("chat.postMessage")).resolves.toMatchObject({ kind: "allowed" });
    await expect(decide("conversations.history")).resolves.toMatchObject({ kind: "denied" });
    await expect(decide("reactions.add")).resolves.toMatchObject({ kind: "denied" });
    await expect(decide("chat.delete")).resolves.toMatchObject({ kind: "denied" });
  });

  it("rejects malformed or missing developer tokens before querying stored token metadata", async () => {
    const resolveDeveloperToken = vi.fn();
    const missing = await evaluateSlackMethodPolicy({
      store: { resolveDeveloperToken },
      bearerToken: undefined,
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "conversations.history",
      requestId: "req_missing",
      now
    });
    const malformed = await evaluateSlackMethodPolicy({
      store: { resolveDeveloperToken },
      bearerToken: "not-a-prism-token",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "conversations.history",
      requestId: "req_malformed",
      now
    });

    expect(resolveDeveloperToken).not.toHaveBeenCalled();
    expect(missing).toMatchObject({ kind: "auth_failed", httpStatus: 401, body: { ok: false, error: "invalid_auth", prism: { errorClass: "invalid_auth" } } });
    expect(malformed).toMatchObject({ kind: "auth_failed", httpStatus: 401, body: { ok: false, error: "invalid_auth", prism: { errorClass: "invalid_auth" } } });
  });

  it("allows registered read methods from the effective Capability map and exposes mutation semantics", async () => {
    const policy = buildTokenProfilePolicy({ preset: "read_only", executionIdentity: "automatic" }, now);
    const decision = await evaluateSlackMethodPolicy({
      store: store(resolved(policy)),
      bearerToken: "prism_dev_readpolicycanaryreadpolicycanary",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "conversations.history",
      requestId: "req_policy",
      requestContext: { workspaceId: "T123", surface: "public_channel" },
      now
    });

    expect(decision).toMatchObject({
      kind: "allowed",
      method: "conversations.history",
      category: "conversations.read",
      tokenProfileId: "profile_1",
      mutation: { narrowingAppliesImmediately: true, broadeningRequiresRotation: true }
    });
    expect(JSON.stringify(decision)).not.toMatch(/prism_dev_|tokenHash|pepper-secret-canary|xox[bp]-|refresh|access_token|client_secret/i);
  });

  it("returns Slack-compatible ok:false diagnostics for denied and unsupported methods without calling Slack", async () => {
    const readOnly = buildTokenProfilePolicy({ preset: "read_only", executionIdentity: "automatic" }, now);
    const denied = await evaluateSlackMethodPolicy({
      store: store(resolved(readOnly)),
      bearerToken: "prism_dev_denypolicycanarydenypolicycanary",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.postMessage",
      requestId: "req_denied",
      requestContext: { workspaceId: "T123", surface: "public_channel" },
      now
    });
    const unsupported = await evaluateSlackMethodPolicy({
      store: store(resolved(readOnly)),
      bearerToken: "prism_dev_unsuppolicycanaryunsuppolicycanary",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "admin.users.list",
      requestId: "req_unsupported",
      now
    });
    const deferred = await evaluateSlackMethodPolicy({
      store: store(resolved(readOnly)),
      bearerToken: "prism_dev_deferredpolicycanarydeferredpolicy",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "files.upload",
      requestId: "req_deferred",
      now
    });

    expect(denied).toMatchObject({
      kind: "denied",
      httpStatus: 200,
      body: {
        ok: false,
        error: "not_allowed",
        prism: { requestId: "req_denied", errorClass: "capability_denied", method: "chat.postMessage", requiredCapability: "writeMessages" }
      }
    });
    expect(unsupported).toMatchObject({
      kind: "unsupported",
      httpStatus: 200,
      body: { ok: false, error: "method_not_supported", prism: { errorClass: "unsupported_method", category: "admin" } }
    });
    expect(deferred).toMatchObject({
      kind: "unsupported",
      httpStatus: 200,
      body: { ok: false, error: "method_not_supported", prism: { errorClass: "deferred_surface", category: "fileTransfer" } }
    });
  });

  it("denies destructive, workspace, surface, and unavailable execution identity mismatches", async () => {
    const fullBridge = buildTokenProfilePolicy({ preset: "full_slack_bridge", executionIdentity: "bot" }, now);
    const destructive = await evaluateSlackMethodPolicy({
      store: store(resolved(fullBridge)),
      bearerToken: "prism_dev_destructivepolicycanarydestructive",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.delete",
      requestId: "req_destructive",
      requestContext: { workspaceId: "T123", surface: "public_channel" },
      now
    });
    const workspace = await evaluateSlackMethodPolicy({
      store: store(resolved(fullBridge)),
      bearerToken: "prism_dev_workspacepolicycanaryworkspacepolicy",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "conversations.history",
      requestId: "req_workspace",
      requestContext: { workspaceId: "T999", surface: "public_channel" },
      now
    });
    const surface = await evaluateSlackMethodPolicy({
      store: store(resolved(fullBridge, { capabilityMap: { ...fullBridge.capabilityMap, surfaces: { ...fullBridge.capabilityMap.surfaces, privateChannels: false } } })),
      bearerToken: "prism_dev_surfacepolicycanarysurfacepolicycanary",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "conversations.history",
      requestId: "req_surface",
      requestContext: { workspaceId: "T123", surface: "private_channel" },
      now
    });
    const missingBot = await evaluateSlackMethodPolicy({
      store: store(resolved(fullBridge, { hasBotCredential: false })),
      bearerToken: "prism_dev_identitypolicycanaryidentitypolicy",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.postMessage",
      requestId: "req_identity",
      requestContext: { workspaceId: "T123", surface: "public_channel" },
      now
    });
    const missingSurface = await evaluateSlackMethodPolicy({
      store: store(resolved(fullBridge)),
      bearerToken: "prism_dev_missingsurfacepolicycanarymissing",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "conversations.history",
      requestId: "req_missing_surface",
      requestContext: { workspaceId: "T123" },
      now
    });

    expect(destructive).toMatchObject({ kind: "denied", body: { prism: { errorClass: "capability_denied", requiredCapability: "destructive" } } });
    expect(workspace).toMatchObject({ kind: "denied", body: { prism: { errorClass: "workspace_denied" } } });
    expect(surface).toMatchObject({ kind: "denied", body: { prism: { errorClass: "surface_denied" } } });
    expect(missingBot).toMatchObject({ kind: "denied", body: { prism: { errorClass: "execution_identity_unavailable" } } });
    expect(missingSurface).toMatchObject({ kind: "denied", body: { prism: { errorClass: "surface_required" } } });
  });

  it("requires the exact organization connection to retain an active workspace grant", async () => {
    const messages = buildTokenProfilePolicy({ preset: "messages_only", executionIdentity: "user" }, now);
    const organizationIdentity = resolved(messages, {
      slackConnectionId: "conn_org_1",
      slackTeamId: null,
      slackEnterpriseId: "E123"
    });
    const allowed = await evaluateSlackMethodPolicy({
      store: store(organizationIdentity, true),
      bearerToken: "prism_dev_orgworkspaceallowedcanarytokenxxxxxxxx",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.postMessage",
      requestId: "req_org_granted",
      requestContext: { workspaceId: "T_GRANTED", surface: "public_channel" },
      now
    });
    const revoked = await evaluateSlackMethodPolicy({
      store: store(organizationIdentity, false),
      bearerToken: "prism_dev_orgworkspacerevokedcanarytokenxxxxxxxx",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.postMessage",
      requestId: "req_org_revoked",
      requestContext: { workspaceId: "T_REVOKED", surface: "public_channel" },
      now
    });

    expect(allowed).toMatchObject({ kind: "allowed" });
    expect(revoked).toMatchObject({
      kind: "denied",
      body: { ok: false, error: "not_allowed", prism: { errorClass: "workspace_denied" } }
    });
  });

  it("fails closed for an organization identity when workspace grant lookup is unavailable", async () => {
    const messages = buildTokenProfilePolicy({ preset: "messages_only", executionIdentity: "user" }, now);
    const decision = await evaluateSlackMethodPolicy({
      store: {
        async resolveDeveloperToken() {
          return resolved(messages, { slackConnectionId: "conn_org_1", slackTeamId: null, slackEnterpriseId: "E123" });
        }
      },
      bearerToken: "prism_dev_orgworkspaceunknowncanarytokenxxxxxxxx",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.postMessage",
      requestId: "req_org_unknown",
      requestContext: { workspaceId: "T_UNKNOWN", surface: "public_channel" },
      now
    });

    expect(decision).toMatchObject({ kind: "denied", body: { prism: { errorClass: "workspace_denied" } } });
  });

  it("denies expired, revoked, bootstrap, reauth, and selectable identity unavailable profiles before forwarding", async () => {
    const messages = buildTokenProfilePolicy({ preset: "messages_only", executionIdentity: "selectable" }, now);
    const expired = await evaluateSlackMethodPolicy({
      store: store(resolved(messages, { tokenExpiresAt: new Date("2025-12-31T23:59:59.000Z") })),
      bearerToken: "prism_dev_expiredpolicycanaryexpiredpolicy",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.postMessage",
      requestId: "req_expired",
      requestContext: { workspaceId: "T123", surface: "public_channel" },
      now
    });
    const revoked = await evaluateSlackMethodPolicy({
      store: store(resolved(messages, { tokenRevokedAt: new Date("2025-12-31T23:59:59.000Z") })),
      bearerToken: "prism_dev_revokedpolicycanaryrevokedpolicy",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.postMessage",
      requestId: "req_revoked",
      requestContext: { workspaceId: "T123", surface: "public_channel" },
      now
    });
    const bootstrap = await evaluateSlackMethodPolicy({
      store: store(resolved(messages, { profileStatus: "bootstrap" })),
      bearerToken: "prism_dev_bootstrappolicycanarybootstrappolicy",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.postMessage",
      requestId: "req_bootstrap",
      requestContext: { workspaceId: "T123", surface: "public_channel" },
      now
    });
    const reauth = await evaluateSlackMethodPolicy({
      store: store(resolved(messages, { slackStatus: "reauth_required" })),
      bearerToken: "prism_dev_reauthpolicycanaryreauthpolicyok",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.postMessage",
      requestId: "req_reauth",
      requestContext: { workspaceId: "T123", surface: "public_channel" },
      now
    });
    const missingSelectableSide = await evaluateSlackMethodPolicy({
      store: store(resolved(messages, { hasUserCredential: true, hasBotCredential: false })),
      bearerToken: "prism_dev_selectablepolicycanaryselectable",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      method: "chat.postMessage",
      requestId: "req_selectable",
      requestContext: { workspaceId: "T123", surface: "public_channel" },
      now
    });

    expect(expired).toMatchObject({ kind: "auth_failed", httpStatus: 401, body: { error: "token_expired" } });
    expect(revoked).toMatchObject({ kind: "auth_failed", httpStatus: 403, body: { error: "token_revoked" } });
    expect(bootstrap).toMatchObject({ kind: "auth_failed", httpStatus: 403, body: { error: "token_revoked" } });
    expect(reauth).toMatchObject({ kind: "denied", body: { prism: { errorClass: "execution_identity_unavailable", unavailableReason: "slack_reauth_required" } } });
    expect(missingSelectableSide).toMatchObject({
      kind: "denied",
      body: { prism: { errorClass: "execution_identity_unavailable", unavailableReason: "missing_execution_identity" } }
    });
  });
});
