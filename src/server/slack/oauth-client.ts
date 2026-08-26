import "server-only";

const SLACK_OAUTH_TIMEOUT_MS = 15_000;

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
  errorClass:
    | "invalid_refresh_token"
    | "invalid_grant"
    | "token_revoked"
    | "token_expired"
    | "account_inactive"
    | "invalid_auth"
    | "invalid_client_id"
    | "bad_client_secret"
    | "ratelimited"
    | "service_unavailable"
    | "request_timeout"
    | "internal_error"
    | "fatal_error"
    | "refresh_token_kind_mismatch"
    | "malformed_refresh_response"
    | "slack_error"
    | "network_error";
};

export type SlackOAuthResult = SlackOAuthSuccess | SlackOAuthFailure;

export type SlackCredentialRefreshSuccess = {
  ok: true;
  credential: {
    accessToken: string;
    refreshToken: string;
    tokenType: "bot" | "user";
    expiresIn: number;
    scope?: string;
  };
};

export type SlackCredentialRefreshResult = SlackCredentialRefreshSuccess | SlackOAuthFailure;

export type SlackOAuthClient = {
  exchangeCode(input: { code: string; redirectUri: string }): Promise<SlackOAuthResult>;
  refreshToken(input: { refreshToken: string; kind: "bot" | "user" }): Promise<SlackCredentialRefreshResult>;
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
  async function postToSlack(fields: Record<string, string>): Promise<Record<string, unknown> | SlackOAuthFailure> {
    try {
      const response = await fetchImpl("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(SLACK_OAUTH_TIMEOUT_MS)
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!body.ok) {
        return { ok: false, errorClass: classifySlackOAuthError(String(body.error ?? "slack_error")) };
      }
      return body;
    } catch {
      return { ok: false, errorClass: "network_error" };
    }
  }

  return {
    async exchangeCode({ code, redirectUri }) {
      const result = await postToSlack({ code, redirect_uri: redirectUri });
      return isOAuthFailure(result) ? result : normalizeSlackOAuthSuccess(result);
    },
    async refreshToken({ refreshToken, kind }) {
      const result = await postToSlack({ grant_type: "refresh_token", refresh_token: refreshToken });
      return isOAuthFailure(result) ? result : normalizeSlackCredentialRefresh(result, kind);
    }
  };
}

export function classifySlackOAuthError(error: string): SlackOAuthFailure["errorClass"] {
  if (knownSlackOAuthErrorClasses.has(error as SlackOAuthFailure["errorClass"])) {
    return error as SlackOAuthFailure["errorClass"];
  }
  return "slack_error";
}

function normalizeSlackOAuthSuccess(body: Record<string, any>): SlackOAuthResult {
  const appId = body.app_id;
  const teamId = body.team?.id;
  const authedUserId = body.authed_user?.id;
  const enterpriseId = body.enterprise?.id;
  if (
    !nonemptySlackIdentifier(appId) ||
    !nonemptySlackIdentifier(teamId) ||
    !nonemptySlackIdentifier(authedUserId) ||
    (body.enterprise !== undefined && body.enterprise !== null && !nonemptySlackIdentifier(enterpriseId))
  ) {
    return { ok: false, errorClass: "slack_error" };
  }

  const topLevelToken = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    tokenType: body.token_type,
    expiresIn: body.expires_in,
    scope: body.scope
  };

  return {
    ok: true,
    appId,
    team: { id: teamId, name: body.team?.name },
    enterprise: body.enterprise ? { id: enterpriseId, name: body.enterprise.name } : null,
    authedUser: {
      id: authedUserId,
      accessToken: body.authed_user?.access_token,
      refreshToken: body.authed_user?.refresh_token,
      tokenType: body.authed_user?.token_type,
      expiresIn: body.authed_user?.expires_in,
      scope: body.authed_user?.scope
    },
    bot: topLevelToken
  };
}

function normalizeSlackCredentialRefresh(
  body: Record<string, unknown>,
  requestedKind: "bot" | "user"
): SlackCredentialRefreshResult {
  const tokenType = body.token_type;
  if (tokenType !== requestedKind) {
    return { ok: false, errorClass: "refresh_token_kind_mismatch" };
  }

  const accessToken = boundedSecret(body.access_token);
  const refreshToken = boundedSecret(body.refresh_token);
  const expiresIn = body.expires_in;
  if (
    !accessToken ||
    !refreshToken ||
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > 31 * 24 * 60 * 60 ||
    (body.scope !== undefined && (typeof body.scope !== "string" || body.scope.length > 8192))
  ) {
    return { ok: false, errorClass: "malformed_refresh_response" };
  }

  return {
    ok: true,
    credential: {
      accessToken,
      refreshToken,
      tokenType: requestedKind,
      expiresIn,
      ...(typeof body.scope === "string" ? { scope: body.scope } : {})
    }
  };
}

const knownSlackOAuthErrorClasses = new Set<SlackOAuthFailure["errorClass"]>([
  "invalid_refresh_token",
  "invalid_grant",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "invalid_auth",
  "invalid_client_id",
  "bad_client_secret",
  "ratelimited",
  "service_unavailable",
  "request_timeout",
  "internal_error",
  "fatal_error"
]);

function isOAuthFailure(value: Record<string, unknown> | SlackOAuthFailure): value is SlackOAuthFailure {
  return value.ok === false && typeof value.errorClass === "string";
}

function boundedSecret(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 ? value : null;
}

function nonemptySlackIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 255;
}
