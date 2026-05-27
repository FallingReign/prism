import { describe, expect, it, vi } from "vitest";

import { enrichSlackConnectionDisplayNames, type SlackConnectionDisplayNameStore } from "./connection-display-names";
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
  it("stores only selected workspace and user display names from server-side Slack lookups", async () => {
    const updates: unknown[] = [];
    const store: SlackConnectionDisplayNameStore = {
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
    expect(webApiClient.callMethod).toHaveBeenCalledTimes(2);
  });
});
