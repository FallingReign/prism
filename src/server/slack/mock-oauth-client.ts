import "server-only";

import type { SlackOAuthClient } from "./oauth-client";

const MOCK_APP_ID = "A0123456789";
const MOCK_TEAM_ID = "T0123456789";
const MOCK_USER_ID = "U0123456789";

export function createMockSlackOAuthClient({
  botScopes = ["channels:read"],
  userScopes = ["search:read"]
}: {
  botScopes?: string[];
  userScopes?: string[];
} = {}): SlackOAuthClient {
  const botScope = botScopes.join(",");
  const userScope = userScopes.join(",");
  return {
    async exchangeCode() {
      return {
        ok: true,
        appId: MOCK_APP_ID,
        team: { id: MOCK_TEAM_ID, name: "Mock workspace" },
        enterprise: null,
        authedUser: {
          id: MOCK_USER_ID,
          accessToken: "xoxp-mock-user-token-canary",
          refreshToken: "mock-user-refresh-secret-canary",
          tokenType: "user",
          expiresIn: 3600,
          scope: userScope
        },
        bot: {
          accessToken: "xoxb-mock-bot-token-canary",
          refreshToken: "mock-bot-refresh-secret-canary",
          tokenType: "bot",
          expiresIn: 3600,
          scope: botScope
        }
      };
    },
    async refreshToken({ kind }) {
      return {
        ok: true,
        appId: MOCK_APP_ID,
        team: { id: MOCK_TEAM_ID },
        authedUser:
          kind === "user"
            ? {
                id: MOCK_USER_ID,
                accessToken: "xoxp-mock-refreshed-token-canary",
                refreshToken: "mock-refreshed-user-refresh-secret-canary",
                tokenType: "user",
                expiresIn: 3600,
                scope: userScope
              }
            : { id: MOCK_USER_ID },
        bot:
          kind === "bot"
            ? {
                accessToken: "xoxb-mock-refreshed-token-canary",
                refreshToken: "mock-refreshed-refresh-secret-canary",
                tokenType: "bot",
                expiresIn: 3600,
                scope: botScope
              }
            : undefined
      };
    }
  };
}
