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
        installationScope: "workspace",
        isEnterpriseInstall: false,
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
        credential: {
          accessToken: kind === "user" ? "xoxp-mock-refreshed-token-canary" : "xoxb-mock-refreshed-token-canary",
          refreshToken: kind === "user" ? "mock-refreshed-user-refresh-secret-canary" : "mock-refreshed-refresh-secret-canary",
          tokenType: kind,
          expiresIn: 3600,
          scope: kind === "user" ? userScope : botScope
        }
      };
    }
  };
}
