import "server-only";

export type SlackOAuthSuccess = {
  ok: true;
  appId: string;
  team: { id: string; name?: string };
  enterprise?: { id: string; name?: string } | null;
  authedUser: {
    id: string;
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expiresIn?: number;
    scope?: string;
  };
  bot?: {
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expiresIn?: number;
    scope?: string;
  };
};

export type SlackOAuthFailure = {
  ok: false;
  errorClass: "invalid_refresh_token" | "invalid_grant" | "token_revoked" | "slack_error" | "network_error";
};

export type SlackOAuthResult = SlackOAuthSuccess | SlackOAuthFailure;

export type SlackOAuthClient = {
  exchangeCode(input: { code: string; redirectUri: string }): Promise<SlackOAuthResult>;
  refreshToken(input: { refreshToken: string; kind: "bot" | "user" }): Promise<SlackOAuthResult>;
};

export function createFetchSlackOAuthClient({
  clientId,
  clientSecret,
  fetchImpl = fetch
}: {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): SlackOAuthClient {
  async function postToSlack(
    fields: Record<string, string>,
    topLevelTokenKind: "bot" | "user" = "bot"
  ): Promise<SlackOAuthResult> {
    try {
      const response = await fetchImpl("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(fields)
      });
      const body = (await response.json()) as Record<string, any>;
      if (!body.ok) {
        return { ok: false, errorClass: classifySlackOAuthError(String(body.error ?? "slack_error")) };
      }

      return normalizeSlackOAuthSuccess(body, topLevelTokenKind);
    } catch {
      return { ok: false, errorClass: "network_error" };
    }
  }

  return {
    exchangeCode({ code, redirectUri }) {
      return postToSlack({ code, redirect_uri: redirectUri });
    },
    refreshToken({ refreshToken, kind }) {
      return postToSlack({ grant_type: "refresh_token", refresh_token: refreshToken }, kind);
    }
  };
}

export function classifySlackOAuthError(error: string): SlackOAuthFailure["errorClass"] {
  if (error === "invalid_refresh_token" || error === "invalid_grant" || error === "token_revoked") {
    return error;
  }
  return "slack_error";
}

function normalizeSlackOAuthSuccess(body: Record<string, any>, topLevelTokenKind: "bot" | "user"): SlackOAuthSuccess {
  const topLevelToken = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    tokenType: body.token_type,
    expiresIn: body.expires_in,
    scope: body.scope
  };

  return {
    ok: true,
    appId: String(body.app_id ?? ""),
    team: { id: String(body.team?.id ?? ""), name: body.team?.name },
    enterprise: body.enterprise ? { id: String(body.enterprise.id ?? ""), name: body.enterprise.name } : null,
    authedUser: {
      id: String(body.authed_user?.id ?? ""),
      accessToken: topLevelTokenKind === "user" ? topLevelToken.accessToken : body.authed_user?.access_token,
      refreshToken: topLevelTokenKind === "user" ? topLevelToken.refreshToken : body.authed_user?.refresh_token,
      tokenType: topLevelTokenKind === "user" ? topLevelToken.tokenType : body.authed_user?.token_type,
      expiresIn: topLevelTokenKind === "user" ? topLevelToken.expiresIn : body.authed_user?.expires_in,
      scope: topLevelTokenKind === "user" ? topLevelToken.scope : body.authed_user?.scope
    },
    bot: topLevelTokenKind === "bot" ? topLevelToken : undefined
  };
}
