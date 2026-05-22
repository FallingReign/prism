import "server-only";

import type { SlackOAuthClient } from "./oauth-client";

export function createMockSlackOAuthClient(): SlackOAuthClient {
  return {
    async exchangeCode() {
      return {
        ok: true,
        appId: "A-MOCK",
        team: { id: "T-MOCK", name: "Mock workspace" },
        enterprise: null,
        authedUser: {
          id: "U-MOCK",
          accessToken: "xoxp-mock-user-token-canary",
          refreshToken: "mock-user-refresh-secret-canary",
          tokenType: "user",
          expiresIn: 3600,
          scope: "search:read"
        },
        bot: {
          accessToken: "xoxb-mock-bot-token-canary",
          refreshToken: "mock-bot-refresh-secret-canary",
          tokenType: "bot",
          expiresIn: 3600,
          scope: "channels:read"
        }
      };
    },
    async refreshToken({ kind }) {
      return {
        ok: true,
        appId: "A-MOCK",
        team: { id: "T-MOCK" },
        authedUser:
          kind === "user"
            ? {
                id: "U-MOCK",
                accessToken: "xoxp-mock-refreshed-token-canary",
                refreshToken: "mock-refreshed-user-refresh-secret-canary",
                tokenType: "user",
                expiresIn: 3600,
                scope: "search:read"
              }
            : { id: "U-MOCK" },
        bot:
          kind === "bot"
            ? {
                accessToken: "xoxb-mock-refreshed-token-canary",
                refreshToken: "mock-refreshed-refresh-secret-canary",
                tokenType: "bot",
                expiresIn: 3600,
                scope: "channels:read"
              }
            : undefined
      };
    }
  };
}
