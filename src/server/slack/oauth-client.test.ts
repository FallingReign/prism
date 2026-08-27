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
      credential: {
        accessToken: "xoxp-new-user-token-canary",
        refreshToken: "new-user-refresh-secret-canary",
        tokenType: "user",
        expiresIn: 3600,
        scope: "search:read"
      }
    });
  });

  it("maps token-only bot refresh responses without installation identity", async () => {
    const client = createFetchSlackOAuthClient({
      clientId: "client-id",
      clientSecret: "client-secret-canary",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue({
        json: async () => ({
          ok: true,
          access_token: "xoxb-new-bot-token-canary",
          refresh_token: "new-bot-refresh-secret-canary",
          token_type: "bot",
          expires_in: 43200,
          scope: "chat:write"
        })
      } as Response)
    });

    await expect(client.refreshToken({ refreshToken: "old-bot-refresh-canary", kind: "bot" })).resolves.toMatchObject({
      ok: true,
      credential: { tokenType: "bot", expiresIn: 43200, scope: "chat:write" }
    });
  });

  it.each([
    ["wrong token kind", { token_type: "bot", access_token: "xoxb-canary", refresh_token: "refresh-canary", expires_in: 3600 }, "refresh_token_kind_mismatch"],
    ["missing replacement refresh token", { token_type: "user", access_token: "xoxp-canary", expires_in: 3600 }, "malformed_refresh_response"],
    ["invalid expiry", { token_type: "user", access_token: "xoxp-canary", refresh_token: "refresh-canary", expires_in: 0 }, "malformed_refresh_response"]
  ])("rejects %s without exposing credential material", async (_label, responseBody, errorClass) => {
    const client = createFetchSlackOAuthClient({
      clientId: "client-id",
      clientSecret: "client-secret-canary",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue({ json: async () => ({ ok: true, ...responseBody }) } as Response)
    });

    const result = await client.refreshToken({ refreshToken: "old-user-refresh-canary", kind: "user" });
    expect(result).toEqual({ ok: false, errorClass });
    expect(JSON.stringify(result)).not.toMatch(/xox[bp]-|refresh-canary/i);
  });

  it("preserves a safe definitive Slack refresh error class", async () => {
    const client = createFetchSlackOAuthClient({
      clientId: "client-id",
      clientSecret: "client-secret-canary",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue({ json: async () => ({ ok: false, error: "token_expired" }) } as Response)
    });

    await expect(client.refreshToken({ refreshToken: "expired-refresh-canary", kind: "user" })).resolves.toEqual({
      ok: false,
      errorClass: "token_expired"
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
      installationScope: "workspace",
      isEnterpriseInstall: false,
      team: { id: "T123", name: "Example Workspace" },
      enterprise: { id: "E123", name: "Example Enterprise" },
      authedUser: { id: "U123" }
    });
  });

  it("accepts Slack organization installs without a team and preserves their enterprise scope", async () => {
    const client = createFetchSlackOAuthClient({
      clientId: "client-id",
      clientSecret: "client-secret-canary",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue({
        json: async () => ({
          ok: true,
          app_id: "A123",
          team: null,
          enterprise: { id: "E123", name: "Example Enterprise" },
          is_enterprise_install: true,
          authed_user: { id: "U123" },
          access_token: "xoxb-bot-token-canary",
          refresh_token: "bot-refresh-secret-canary",
          token_type: "bot",
          expires_in: 3600,
          scope: "chat:write"
        })
      } as Response)
    });

    await expect(client.exchangeCode({ code: "code-123", redirectUri: "http://localhost/callback" })).resolves.toMatchObject({
      ok: true,
      installationScope: "organization",
      isEnterpriseInstall: true,
      team: null,
      enterprise: { id: "E123", name: "Example Enterprise" }
    });
  });

  it.each([
    ["missing enterprise flag", { team: null, enterprise: { id: "E123" } }],
    ["missing enterprise id", { team: null, enterprise: null, is_enterprise_install: true }],
    ["contradictory team", { team: { id: "T123" }, enterprise: { id: "E123" }, is_enterprise_install: true }]
  ])("rejects a contradictory organization install: %s", async (_label, installation) => {
    const client = createFetchSlackOAuthClient({
      clientId: "client-id",
      clientSecret: "client-secret-canary",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue({
        json: async () => ({ ok: true, app_id: "A123", authed_user: { id: "U123" }, ...installation })
      } as Response)
    });

    await expect(client.exchangeCode({ code: "code-123", redirectUri: "http://localhost/callback" })).resolves.toEqual({
      ok: false,
      errorClass: "slack_error"
    });
  });

  it.each([
    ["app", { app_id: 123 }],
    ["team", { team: { id: 123 } }],
    ["user", { authed_user: { id: 123 } }]
  ])("rejects a non-string Slack %s identifier before normalization", async (_label, override) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({
        ok: true,
        app_id: "A123",
        team: { id: "T123" },
        authed_user: { id: "U123" },
        ...override
      })
    } as Response);
    const client = createFetchSlackOAuthClient({ clientId: "client-id", clientSecret: "client-secret-canary", fetchImpl });

    await expect(client.exchangeCode({ code: "code-123", redirectUri: "http://localhost:3732/v1/slack/oauth/callback" })).resolves.toEqual({
      ok: false,
      errorClass: "slack_error"
    });
  });
});
