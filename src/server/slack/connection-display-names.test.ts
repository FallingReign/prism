import { describe, expect, it, vi } from "vitest";

import {
  DISPLAY_NAME_ENRICHMENT_RETRY_COOLDOWN_MS,
  enrichSlackConnectionDisplayNames,
  needsSlackConnectionDisplayNameEnrichment,
  type SlackConnectionDisplayNameStore
} from "./connection-display-names";
import type { SlackForwardingCredentialProvider } from "./forwarding-credentials";
import type { SlackWebApiClient } from "./web-api-client";

const connection = {
  connectionId: "conn_1",
  status: "healthy" as const,
  teamId: "T123",
  teamName: null,
  enterpriseId: "E123",
  enterpriseName: null,
  slackUserId: "U123",
  slackUserDisplayName: null,
  displayNamesEnrichedAt: null,
  lastErrorClass: null
};

describe("Slack connection display-name enrichment", () => {
  it("retries a healthy missing user name only after the persisted cooldown", () => {
    const attemptedAt = new Date("2026-01-01T00:00:00.000Z");
    const attemptedConnection = { ...connection, displayNamesEnrichedAt: attemptedAt };

    expect(
      needsSlackConnectionDisplayNameEnrichment(
        attemptedConnection,
        new Date(attemptedAt.getTime() + DISPLAY_NAME_ENRICHMENT_RETRY_COOLDOWN_MS - 1)
      )
    ).toBe(false);
    expect(
      needsSlackConnectionDisplayNameEnrichment(
        attemptedConnection,
        new Date(attemptedAt.getTime() + DISPLAY_NAME_ENRICHMENT_RETRY_COOLDOWN_MS)
      )
    ).toBe(true);
  });

  it("does not retry user profile lookup after a safe user name is stored", async () => {
    const namedConnection = {
      ...connection,
      teamName: null,
      slackUserDisplayName: "Ada Lovelace",
      displayNamesEnrichedAt: null
    };
    const callMethod = vi.fn(async ({ method }: { method: string }) => {
      if (method === "auth.test") {
        return { status: 200, body: { ok: true, team: "Example Workspace", team_id: "T123" } };
      }
      throw new Error("users.info must not run after a safe name exists");
    });

    await enrichSlackConnectionDisplayNames({
      connection: namedConnection,
      store: {
        async claimConnectionDisplayNameEnrichmentAttempt() {
          return true;
        },
        async updateConnectionDisplayNames(input) {
          return { ...namedConnection, ...input, displayNamesEnrichedAt: input.enrichedAt };
        }
      },
      credentialProvider: {
        async getAccessToken() {
          return { kind: "available", accessToken: "xoxp-user-token-canary" };
        }
      },
      webApiClient: { callMethod },
      now: new Date("2026-01-01T01:00:00.000Z")
    });

    expect(callMethod).toHaveBeenCalledTimes(1);
    expect(callMethod).toHaveBeenCalledWith(expect.objectContaining({ method: "auth.test" }));
  });

  it("allows only one concurrent caller to claim a missing-name lookup", async () => {
    let claimed = false;
    let updated = 0;
    const store: SlackConnectionDisplayNameStore = {
      async claimConnectionDisplayNameEnrichmentAttempt() {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      async updateConnectionDisplayNames(input) {
        updated += 1;
        return { ...connection, ...input, displayNamesEnrichedAt: input.enrichedAt };
      }
    };
    const callMethod = vi.fn(async ({ method }: { method: string }) => {
      if (method === "auth.test") {
        return { status: 200, body: { ok: true, team: "Example Workspace", team_id: "T123" } };
      }
      return { status: 200, body: { ok: true, user: { id: "U123", profile: { display_name: "Ada" } } } };
    });
    const dependencies = {
      connection,
      store,
      credentialProvider: {
        async getAccessToken() {
          return { kind: "available" as const, accessToken: "xoxp-user-token-canary" };
        }
      },
      webApiClient: { callMethod },
      now: new Date("2026-01-01T01:00:00.000Z")
    };

    await Promise.all([
      enrichSlackConnectionDisplayNames(dependencies),
      enrichSlackConnectionDisplayNames(dependencies)
    ]);

    expect(callMethod).toHaveBeenCalledTimes(2);
    expect(updated).toBe(1);
  });

  it("stores only selected workspace and user display names from server-side Slack lookups", async () => {
    const updates: unknown[] = [];
    const store: SlackConnectionDisplayNameStore = {
      async claimConnectionDisplayNameEnrichmentAttempt() {
        return true;
      },
      async updateConnectionDisplayNames(input) {
        updates.push(input);
        return {
          ...connection,
          teamName: input.teamName,
          enterpriseName: input.enterpriseName,
          slackUserDisplayName: input.slackUserDisplayName,
          displayNamesEnrichedAt: input.enrichedAt
        };
      }
    };
    const credentialProvider: SlackForwardingCredentialProvider = {
      async getAccessToken({ kind }) {
        expect(kind).toBe("user");
        return { kind: "available", accessToken: "xoxp-user-token-canary" };
      }
    };
    const webApiClient: SlackWebApiClient = {
      callMethod: vi.fn(async ({ method, accessToken, payload }) => {
        expect(accessToken).toBe("xoxp-user-token-canary");
        if (method === "auth.test") {
          return { status: 200, body: { ok: true, team: "Example Workspace", team_id: "T123", user: "fallback-user", user_id: "U123" } };
        }
        if (method === "users.info") {
          expect(payload).toEqual({ user: "U123" });
          return {
            status: 200,
            body: {
              ok: true,
              user: {
                id: "U123",
                name: "fallback-user",
                real_name: "Ada Real Name",
                profile: {
                  display_name_normalized: "Ada Lovelace",
                  email: "must-not-store@example.test",
                  image_192: "https://example.test/must-not-store.png",
                  status_text: "must not store"
                }
              }
            }
          };
        }
        throw new Error(`unexpected method ${method}`);
      })
    };

    await expect(
      enrichSlackConnectionDisplayNames({
        connection,
        store,
        credentialProvider,
        webApiClient,
        now: new Date("2026-01-01T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      teamName: "Example Workspace",
      enterpriseName: null,
      slackUserDisplayName: "Ada Lovelace"
    });

    expect(webApiClient.callMethod).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updates)).not.toMatch(/xoxp|must-not-store|email|image_192|status_text/i);
  });

  it("tries the bot credential for users.info when the user credential only gives an auth.test fallback", async () => {
    const credentialProvider: SlackForwardingCredentialProvider = {
      async getAccessToken({ kind }) {
        return { kind: "available", accessToken: `xox${kind === "user" ? "p" : "b"}-${kind}-token-canary` };
      }
    };
    const webApiClient: SlackWebApiClient = {
      callMethod: vi.fn(async ({ method, executionMode }) => {
        if (method === "auth.test") {
          return { status: 200, body: { ok: true, team: "Example Workspace", team_id: "T123", user: "fallback-user", user_id: "U123" } };
        }
        if (executionMode === "user") return { status: 200, body: { ok: false, error: "missing_scope" } };
        return { status: 200, body: { ok: true, user: { id: "U123", profile: { display_name_normalized: "Ada Bot Lookup" } } } };
      })
    };

    await expect(
      enrichSlackConnectionDisplayNames({
        connection,
        store: {
          async claimConnectionDisplayNameEnrichmentAttempt() {
            return true;
          },
          async updateConnectionDisplayNames(input) {
            return { ...connection, ...input, displayNamesEnrichedAt: input.enrichedAt };
          }
        },
        credentialProvider,
        webApiClient
      })
    ).resolves.toMatchObject({
      slackUserDisplayName: "Ada Bot Lookup"
    });

    expect(webApiClient.callMethod).toHaveBeenCalledTimes(4);
  });

  it("stores an org-level auth.test team string as the enterprise display name", async () => {
    const orgConnection = {
      ...connection,
      teamId: null,
      teamName: null,
      enterpriseId: "E123",
      enterpriseName: null,
      slackUserDisplayName: "Ada Lovelace"
    };
    const credentialProvider: SlackForwardingCredentialProvider = {
      async getAccessToken() {
        return { kind: "available", accessToken: "xoxp-user-token-canary" };
      }
    };
    const webApiClient: SlackWebApiClient = {
      callMethod: vi.fn(async ({ method }) => {
        if (method === "auth.test") {
          return { status: 200, body: { ok: true, team: "Example Org", team_id: "E123", user: "fallback-user", user_id: "U123", enterprise_id: "E123" } };
        }
        return { status: 200, body: { ok: false, error: "missing_scope" } };
      })
    };

    await expect(
      enrichSlackConnectionDisplayNames({
        connection: orgConnection,
        store: {
          async claimConnectionDisplayNameEnrichmentAttempt() {
            return true;
          },
          async updateConnectionDisplayNames(input) {
            return {
              ...orgConnection,
              teamName: input.teamName,
              enterpriseName: input.enterpriseName,
              slackUserDisplayName: input.slackUserDisplayName,
              displayNamesEnrichedAt: input.enrichedAt
            };
          }
        },
        credentialProvider,
        webApiClient
      })
    ).resolves.toMatchObject({
      teamName: null,
      enterpriseName: "Example Org",
      slackUserDisplayName: "Ada Lovelace"
    });
    expect(webApiClient.callMethod).toHaveBeenCalledTimes(1);
  });
});
