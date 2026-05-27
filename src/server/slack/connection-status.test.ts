import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { hashSecret } from "./oauth-flow";
import { getSlackLinkStatusWithDisplayNameEnrichment } from "./connection-status";
import type { SlackConnectionDisplayNameStore } from "./connection-display-names";
import type { SlackForwardingCredentialProvider } from "./forwarding-credentials";
import type { SlackWebApiClient } from "./web-api-client";

describe("Slack website status display names", () => {
  it("enriches missing names once before returning the website status", async () => {
    const displayNameStore: SlackConnectionDisplayNameStore = {
      async updateConnectionDisplayNames(input) {
        expect(input).toMatchObject({
          connectionId: "conn_1",
          teamName: "Example Workspace",
          slackUserDisplayName: "Ada Lovelace"
        });
        return {
          connectionId: "conn_1",
          status: "healthy",
          teamId: "T123",
          teamName: input.teamName,
          enterpriseId: null,
          enterpriseName: input.enterpriseName,
          slackUserId: "U123",
          slackUserDisplayName: input.slackUserDisplayName,
          displayNamesEnrichedAt: input.enrichedAt,
          lastErrorClass: null
        };
      }
    };
    const credentialProvider: SlackForwardingCredentialProvider = {
      async getAccessToken() {
        return { kind: "available", accessToken: "xoxp-user-token-canary" };
      }
    };
    const webApiClient: SlackWebApiClient = {
      callMethod: vi.fn(async ({ method }) => {
        if (method === "auth.test") return { status: 200, body: { ok: true, team: "Example Workspace", team_id: "T123", user: "fallback-user", user_id: "U123" } };
        return { status: 200, body: { ok: true, user: { id: "U123", profile: { display_name: "Ada Lovelace" } } } };
      })
    };

    await expect(
      getSlackLinkStatusWithDisplayNameEnrichment({
        database: fakeDatabase(),
        sessionToken: "session-token",
        displayNameStore,
        credentialProvider,
        webApiClient,
        now: new Date("2026-01-01T00:00:00.000Z")
      })
    ).resolves.toEqual({
      kind: "linked",
      status: "healthy",
      teamId: "T123",
      teamName: "Example Workspace",
      enterpriseId: null,
      enterpriseName: null,
      slackUserId: "U123",
      slackUserDisplayName: "Ada Lovelace",
      lastErrorClass: null
    });
  });

  it("keeps linked ID fallback status when display-name enrichment fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const displayNameStore: SlackConnectionDisplayNameStore = {
      async updateConnectionDisplayNames() {
        throw new Error("database-write-failed");
      }
    };
    const credentialProvider: SlackForwardingCredentialProvider = {
      async getAccessToken() {
        return { kind: "available", accessToken: "xoxp-user-token-canary" };
      }
    };
    const webApiClient: SlackWebApiClient = {
      async callMethod() {
        return { status: 200, body: { ok: true, team: "Example Workspace", team_id: "T123", user: "fallback-user", user_id: "U123" } };
      }
    };

    await expect(
      getSlackLinkStatusWithDisplayNameEnrichment({
        database: fakeDatabase(),
        sessionToken: "session-token",
        displayNameStore,
        credentialProvider,
        webApiClient
      })
    ).resolves.toEqual({
      kind: "linked",
      status: "healthy",
      teamId: "T123",
      teamName: null,
      enterpriseId: null,
      enterpriseName: null,
      slackUserId: "U123",
      slackUserDisplayName: null,
      lastErrorClass: null
    });
    expect(consoleError).toHaveBeenCalledWith(
      "prism_slack_connection_display_name_enrichment_failed",
      expect.objectContaining({ connectionId: "conn_1", errorName: "Error" })
    );
    consoleError.mockRestore();
  });
});

function fakeDatabase(): Database {
  return {
    async query(sql: string, params?: unknown[]) {
      expect(sql).toContain("from prism_sessions");
      expect(params).toEqual([hashSecret("session-token")]);
      return {
        rows: [
          {
            id: "conn_1",
            status: "healthy",
            team_id: "T123",
            team_name: null,
            enterprise_id: null,
            enterprise_name: null,
            authed_user_id: "U123",
            authed_user_display_name: null,
            display_names_enriched_at: null,
            last_error_class: null
          }
        ],
        rowCount: 1
      };
    },
    async transaction(callback) {
      return callback(this);
    }
  };
}
