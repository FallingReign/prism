import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { hashSecret } from "./oauth-flow";
import { createPostgresOAuthFlowStore, getSlackLinkStatus } from "./postgres-store";

describe("Postgres Slack website status", () => {
  it("returns friendly workspace and organization names from the session-scoped connection", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("from prism_sessions");
      expect(sql).toContain("team_name");
      expect(sql).toContain("enterprise_name");
      expect(sql).toContain("authed_user_display_name");
      expect(sql).toContain("display_names_enriched_at");
      expect(params).toEqual([hashSecret("session-token")]);
      return {
        rows: [
          {
            id: "conn_1",
            status: "healthy",
            team_id: "T123",
            team_name: "Example Workspace",
            enterprise_id: "E123",
            enterprise_name: "Example Enterprise",
            authed_user_id: "U123",
            authed_user_display_name: "Ada Lovelace",
            display_names_enriched_at: new Date("2026-01-01T00:00:00.000Z"),
            last_error_class: null
          }
        ],
        rowCount: 1
      };
    });

    await expect(getSlackLinkStatus(fakeDatabase(query), "session-token")).resolves.toEqual({
      kind: "linked",
      status: "healthy",
      teamId: "T123",
      teamName: "Example Workspace",
      enterpriseId: "E123",
      enterpriseName: "Example Enterprise",
      slackUserId: "U123",
      slackUserDisplayName: "Ada Lovelace",
      lastErrorClass: null
    });
  });
});

describe("Postgres Slack OAuth continuation state", () => {
  it("stores and consumes only the typed delegated-delivery request binding", async () => {
    const delegatedDeliveryRequestId = "ddr_12345678-1234-4123-8123-123456789012";
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("insert into slack_oauth_states")) {
        expect(sql).toContain("delegated_delivery_request_id");
        expect(params).toEqual([
          "state-hash",
          "http://localhost:3732/v1/slack/oauth/callback",
          null,
          delegatedDeliveryRequestId,
          new Date("2026-08-22T00:10:00.000Z")
        ]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update slack_oauth_states")) {
        expect(sql).toContain("delegated_delivery_request_id");
        return {
          rows: [{
            redirect_uri: "http://localhost:3732/v1/slack/oauth/callback",
            oidc_authorization_request_id: null,
            delegated_delivery_request_id: delegatedDeliveryRequestId
          }],
          rowCount: 1
        };
      }
      throw new Error(`unexpected-sql:${sql.slice(0, 80)}`);
    });
    const store = createPostgresOAuthFlowStore(fakeDatabase(query));
    await store.saveOAuthState({
      stateHash: "state-hash",
      redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
      oidcAuthorizationRequestId: null,
      delegatedDeliveryRequestId,
      expiresAt: new Date("2026-08-22T00:10:00.000Z")
    });

    await expect(store.consumeOAuthState({
      stateHash: "state-hash",
      now: new Date("2026-08-22T00:00:00.000Z")
    })).resolves.toEqual({
      redirectUri: "http://localhost:3732/v1/slack/oauth/callback",
      oidcAuthorizationRequestId: null,
      delegatedDeliveryRequestId
    });
  });
});

function fakeDatabase(query: unknown): Database {
  return {
    query: query as Database["query"],
    transaction: async (callback) => callback(fakeDatabase(query))
  };
}
