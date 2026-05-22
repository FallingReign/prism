import { describe, expect, it } from "vitest";

import { buildTokenProfilePolicy } from "./presets";
import { getPrismTokenStatus, type LocalToolTokenStore, type ResolvedDeveloperToken } from "./local-tool-status";

const now = new Date("2026-01-01T00:00:00.000Z");
const activePolicy = buildTokenProfilePolicy({ preset: "messages_only", executionIdentity: "user" }, now);

function record(overrides: Partial<ResolvedDeveloperToken> = {}): ResolvedDeveloperToken {
  return {
    tokenProfileId: "profile_1",
    tokenExpiresAt: activePolicy.expiresAt,
    tokenRevokedAt: null,
    profileStatus: "active",
    profileExpiresAt: activePolicy.expiresAt,
    preset: "messages_only",
    capabilityMap: activePolicy.capabilityMap,
    slackStatus: "healthy",
    slackLastErrorClass: null,
    hasUserCredential: true,
    hasBotCredential: true,
    ...overrides
  };
}

function store(resolved: ResolvedDeveloperToken | null): LocalToolTokenStore {
  return {
    async resolveDeveloperToken() {
      return resolved;
    }
  };
}

describe("Local-tool Prism token status", () => {
  it("reports healthy active status without exposing bearer token or verifier material", async () => {
    const lastUsedAt = new Date("2025-12-31T23:59:00.000Z");
    const overlapExpiresAt = new Date("2026-01-01T00:15:00.000Z");
    const result = await getPrismTokenStatus({
      store: store(record({ tokenLastUsedAt: lastUsedAt, tokenOverlapExpiresAt: overlapExpiresAt, tokenIsCurrent: false })),
      bearerToken: "prism_dev_canarycanarycanarycanarycanarycanarycanary",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      requestId: "req_123",
      now
    });

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      requestId: "req_123",
      token: {
        valid: true,
        status: "active",
        tokenProfileId: "profile_1",
        lastUsedAt: "2025-12-31T23:59:00.000Z",
        overlapExpiresAt: "2026-01-01T00:15:00.000Z"
      },
      slack: { connected: true, status: "healthy", reauthRequired: false },
      executionIdentity: {
        configured: "user",
        available: true,
        unavailableReason: null,
        modes: { user: true, bot: true, automatic: true, selectable: true }
      }
    });
    expect(JSON.stringify(result.body)).not.toMatch(/prism_dev_canary|tokenHash|pepper-secret-canary|xox[bp]-|refresh|access_token|client_secret/i);
  });

  it("classifies invalid, expired, revoked, Reauth required, and missing identity states", async () => {
    const malformed = await getPrismTokenStatus({
      store: store(null),
      bearerToken: "not-a-prism-token",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      requestId: "req_invalid",
      now
    });
    const expired = await getPrismTokenStatus({
      store: store(record({ tokenExpiresAt: new Date("2025-12-31T00:00:00.000Z") })),
      bearerToken: "prism_dev_expiredcanaryexpiredcanaryexpiredcanary",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      requestId: "req_expired",
      now
    });
    const revoked = await getPrismTokenStatus({
      store: store(record({ tokenRevokedAt: now })),
      bearerToken: "prism_dev_revokedcanaryrevokedcanaryrevokedcanary",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      requestId: "req_revoked",
      now
    });
    const overlapExpired = await getPrismTokenStatus({
      store: store(
        record({
          tokenExpiresAt: new Date("2025-12-31T23:45:00.000Z"),
          tokenOverlapExpiresAt: new Date("2025-12-31T23:45:00.000Z"),
          tokenIsCurrent: false
        })
      ),
      bearerToken: "prism_dev_overlapexpiredcanaryoverlapexpired",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      requestId: "req_overlap_expired",
      now
    });
    const reauth = await getPrismTokenStatus({
      store: store(record({ slackStatus: "reauth_required", slackLastErrorClass: "invalid_refresh_token" })),
      bearerToken: "prism_dev_reauthcanaryreauthcanaryreauthcanary",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      requestId: "req_reauth",
      now
    });
    const botPolicy = buildTokenProfilePolicy({ preset: "full_slack_bridge", executionIdentity: "bot" }, now);
    const missingBot = await getPrismTokenStatus({
      store: store(record({ capabilityMap: botPolicy.capabilityMap, hasBotCredential: false })),
      bearerToken: "prism_dev_missingbotcanarymissingbotcanary",
      developerTokenConfig: { pepper: "pepper-secret-canary", pepperId: "local-pepper" },
      requestId: "req_missing_bot",
      now
    });

    expect(malformed).toMatchObject({ httpStatus: 401, body: { token: { valid: false, status: "invalid" }, requestId: "req_invalid" } });
    expect(expired).toMatchObject({ httpStatus: 401, body: { token: { valid: false, status: "expired" }, requestId: "req_expired" } });
    expect(overlapExpired).toMatchObject({
      httpStatus: 401,
      body: { token: { valid: false, status: "expired", expiresAt: "2025-12-31T23:45:00.000Z" }, requestId: "req_overlap_expired" }
    });
    expect(revoked).toMatchObject({ httpStatus: 403, body: { token: { valid: false, status: "revoked" }, requestId: "req_revoked" } });
    expect(reauth).toMatchObject({
      httpStatus: 200,
      body: {
        slack: { status: "reauth_required", reauthRequired: true, lastErrorClass: "reauth_required" },
        executionIdentity: { available: false, unavailableReason: "slack_reauth_required" }
      }
    });
    expect(missingBot).toMatchObject({
      httpStatus: 200,
      body: { executionIdentity: { configured: "bot", available: false, unavailableReason: "missing_bot_identity" } }
    });
    expect(JSON.stringify({ malformed, expired, revoked, reauth, missingBot })).not.toMatch(
      /prism_dev_|tokenHash|pepper-secret-canary|xox[bp]-|refresh|access_token|client_secret/i
    );
  });
});
