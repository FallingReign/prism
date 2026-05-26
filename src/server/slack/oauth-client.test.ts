import { describe, expect, it, vi } from "vitest";

import { createFetchSlackOAuthClient } from "./oauth-client";

describe("Slack OAuth client", () => {
  it("uses Basic auth for code exchange and returns sanitized failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({ ok: false, error: "invalid_client_secret" })
    } as Response);
    const client = createFetchSlackOAuthClient({ clientId: "client-id", clientSecret: "client-secret-canary", fetchImpl });

    const result = await client.exchangeCode({ code: "code-123", redirectUri: "http://localhost:3732/v1/slack/oauth/callback" });
    const [, init] = fetchImpl.mock.calls[0]!;

    expect(result).toEqual({ ok: false, errorClass: "slack_error" });
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("client-id:client-secret-canary").toString("base64")}`
    });
    expect(String((init as RequestInit).body)).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A3732%2Fv1%2Fslack%2Foauth%2Fcallback");
    expect(JSON.stringify(result)).not.toContain("client-secret-canary");
  });

  it("maps top-level Slack token rotation responses to user credentials when refreshing a user token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        ok: true,
        app_id: "A123",
        team: { id: "T123" },
        authed_user: { id: "U123" },
        access_token: "xoxp-new-user-token-canary",
        refresh_token: "new-user-refresh-secret-canary",
        token_type: "user",
        expires_in: 3600,
        scope: "search:read"
      })
    } as Response);
    const client = createFetchSlackOAuthClient({ clientId: "client-id", clientSecret: "client-secret-canary", fetchImpl });

    const result = await client.refreshToken({ refreshToken: "old-user-refresh-secret-canary", kind: "user" });

    expect(result).toMatchObject({
      ok: true,
      authedUser: {
        id: "U123",
        accessToken: "xoxp-new-user-token-canary",
        refreshToken: "new-user-refresh-secret-canary",
        tokenType: "user",
        expiresIn: 3600,
        scope: "search:read"
      },
      bot: undefined
    });
  });

  it("normalizes workspace and enterprise display names from OAuth responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        ok: true,
        app_id: "A123",
        team: { id: "T123", name: "Example Workspace" },
        enterprise: { id: "E123", name: "Example Enterprise" },
        authed_user: { id: "U123" },
        access_token: "xoxb-bot-token-canary",
        refresh_token: "bot-refresh-secret-canary",
        token_type: "bot",
        expires_in: 3600,
        scope: "channels:read"
      })
    } as Response);
    const client = createFetchSlackOAuthClient({ clientId: "client-id", clientSecret: "client-secret-canary", fetchImpl });

    const result = await client.exchangeCode({ code: "code-123", redirectUri: "http://localhost:3732/v1/slack/oauth/callback" });

    expect(result).toMatchObject({
      ok: true,
      team: { id: "T123", name: "Example Workspace" },
      enterprise: { id: "E123", name: "Example Enterprise" },
      authedUser: { id: "U123" }
    });
  });
});
