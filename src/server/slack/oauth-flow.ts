import "server-only";

import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

import type { CredentialCipher, CredentialEnvelope } from "../credentials/encryption";
import type { SlackOAuthClient, SlackOAuthSuccess } from "./oauth-client";

export const slackOAuthStateCookieName = "prism_slack_oauth_state";
export const prismSessionCookieName = "prism_session";

export type SlackOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  publicBaseUrl: string;
  botScopes: string[];
  userScopes: string[];
};

export type CookieSpec = {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

export type OAuthFlowStore = {
  transaction<T>(callback: (store: OAuthFlowStore) => Promise<T>): Promise<T>;
  saveOAuthState(input: {
    stateHash: string;
    redirectUri: string;
    oidcAuthorizationRequestId?: string | null;
    expiresAt: Date;
  }): Promise<void>;
  consumeOAuthState(input: {
    stateHash: string;
    now: Date;
  }): Promise<{
    redirectUri: string;
    oidcAuthorizationRequestId: string | null;
  } | null>;
  upsertPrismUser(input: { slackTeamId: string; slackUserId: string; slackEnterpriseId: string | null }): Promise<{ id: string }>;
  upsertSlackConnection(input: {
    prismUserId: string;
    teamId: string;
    teamName: string | null;
    enterpriseId: string | null;
    enterpriseName: string | null;
    authedUserId: string;
    appId: string;
    botScopes: string;
    userScopes: string;
  }): Promise<{ id: string }>;
  saveSlackCredential(input: {
    connectionId: string;
    kind: "bot" | "user";
    tokenType: string | null;
    accessTokenEnvelope: CredentialEnvelope;
    refreshTokenEnvelope: CredentialEnvelope | null;
    expiresAt: Date | null;
    scopes: string | null;
  }): Promise<void>;
  createWebsiteSession(input: { sessionTokenHash: string; prismUserId: string; expiresAt: Date }): Promise<void>;
};

export async function createSlackOAuthStart({
  store,
  config,
  oidcAuthorizationRequestId = null,
  now = new Date(),
  randomBytes = nodeRandomBytes
}: {
  store: OAuthFlowStore;
  config: SlackOAuthConfig;
  oidcAuthorizationRequestId?: string | null;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<{ state: string; stateHash: string; redirectUrl: string; cookie: CookieSpec }> {
  const state = randomBytes(32).toString("base64url");
  const stateHash = hashSecret(state);
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  await store.saveOAuthState({
    stateHash,
    redirectUri: config.redirectUri,
    oidcAuthorizationRequestId,
    expiresAt
  });

  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("redirect_uri", config.redirectUri);
  authorize.searchParams.set("state", state);
  if (config.botScopes.length > 0) authorize.searchParams.set("scope", config.botScopes.join(","));
  if (config.userScopes.length > 0) authorize.searchParams.set("user_scope", config.userScopes.join(","));

  return {
    state,
    stateHash,
    redirectUrl: authorize.toString(),
    cookie: oauthStateCookie(state, config.publicBaseUrl)
  };
}

export async function completeSlackOAuthCallback({
  store,
  cipher,
  config,
  slackOAuthClient,
  code,
  state,
  cookieState,
  oauthError = null,
  now = new Date(),
  randomBytes = nodeRandomBytes
}: {
  store: OAuthFlowStore;
  cipher: CredentialCipher;
  config: SlackOAuthConfig;
  slackOAuthClient: SlackOAuthClient;
  code: string | null;
  state: string | null;
  cookieState: string | null;
  oauthError?: string | null;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<
  | {
      kind: "linked";
      redirectUrl: string;
      sessionCookie: CookieSpec;
      oidcAuthorizationRequestId: string | null;
    }
  | {
      kind: "invalid_state" | "slack_error";
      redirectUrl: string;
      oidcAuthorizationRequestId?: string | null;
      sessionCookie?: undefined;
    }
> {
  if (!state || !cookieState || !equalSecret(state, cookieState)) {
    return { kind: "invalid_state", redirectUrl: statusRedirect(config, "error") };
  }

  const storedState = await store.consumeOAuthState({ stateHash: hashSecret(state), now });
  if (!storedState || storedState.redirectUri !== config.redirectUri) {
    return { kind: "invalid_state", redirectUrl: statusRedirect(config, "error") };
  }

  if (oauthError || !code) {
    return {
      kind: "slack_error",
      redirectUrl: statusRedirect(config, "error"),
      oidcAuthorizationRequestId: storedState.oidcAuthorizationRequestId
    };
  }

  const slackResult = await slackOAuthClient.exchangeCode({ code, redirectUri: config.redirectUri });
  if (!slackResult.ok) {
    return {
      kind: "slack_error",
      redirectUrl: statusRedirect(config, "error"),
      oidcAuthorizationRequestId: storedState.oidcAuthorizationRequestId
    };
  }

  if (
    !nonemptySlackIdentifier(slackResult.appId) ||
    !nonemptySlackIdentifier(slackResult.team.id) ||
    !nonemptySlackIdentifier(slackResult.authedUser.id)
  ) {
    return {
      kind: "slack_error",
      redirectUrl: statusRedirect(config, "error"),
      oidcAuthorizationRequestId: storedState.oidcAuthorizationRequestId
    };
  }

  const sessionToken = randomBytes(32).toString("base64url");
  await store.transaction(async (transactionStore) => {
    const prismUser = await transactionStore.upsertPrismUser({
      slackTeamId: slackResult.team.id,
      slackUserId: slackResult.authedUser.id,
      slackEnterpriseId: slackResult.enterprise?.id ?? null
    });
    const connection = await transactionStore.upsertSlackConnection({
      prismUserId: prismUser.id,
      teamId: slackResult.team.id,
      teamName: slackResult.team.name ?? null,
      enterpriseId: slackResult.enterprise?.id ?? null,
      enterpriseName: slackResult.enterprise?.name ?? null,
      authedUserId: slackResult.authedUser.id,
      appId: slackResult.appId,
      botScopes: slackResult.bot?.scope ?? "",
      userScopes: slackResult.authedUser.scope ?? ""
    });

    await storeCredentialIfPresent({
      store: transactionStore,
      cipher,
      connectionId: connection.id,
      kind: "bot",
      token: slackResult.bot,
      now
    });
    await storeCredentialIfPresent({
      store: transactionStore,
      cipher,
      connectionId: connection.id,
      kind: "user",
      token: slackResult.authedUser,
      now
    });

    await transactionStore.createWebsiteSession({
      sessionTokenHash: hashSecret(sessionToken),
      prismUserId: prismUser.id,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    });
  });

  return {
    kind: "linked",
    redirectUrl: statusRedirect(config, "linked"),
    sessionCookie: sessionCookie(sessionToken, config.publicBaseUrl),
    oidcAuthorizationRequestId: storedState.oidcAuthorizationRequestId
  };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function equalSecret(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

function nonemptySlackIdentifier(value: string): boolean {
  return value.trim().length > 0 && value.length <= 255;
}

function oauthStateCookie(value: string, publicBaseUrl: string): CookieSpec {
  return {
    name: slackOAuthStateCookieName,
    value,
    httpOnly: true,
    sameSite: "lax",
    secure: publicBaseUrl.startsWith("https://"),
    path: "/",
    maxAge: 10 * 60
  };
}

function sessionCookie(value: string, publicBaseUrl: string): CookieSpec {
  return {
    name: prismSessionCookieName,
    value,
    httpOnly: true,
    sameSite: "lax",
    secure: publicBaseUrl.startsWith("https://"),
    path: "/",
    maxAge: 30 * 24 * 60 * 60
  };
}

function statusRedirect(config: SlackOAuthConfig, status: "linked" | "error"): string {
  const url = new URL(config.publicBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("slack", status);
  return url.toString();
}

async function storeCredentialIfPresent({
  store,
  cipher,
  connectionId,
  kind,
  token,
  now
}: {
  store: OAuthFlowStore;
  cipher: CredentialCipher;
  connectionId: string;
  kind: "bot" | "user";
  token?: SlackOAuthSuccess["bot"] | SlackOAuthSuccess["authedUser"];
  now: Date;
}): Promise<void> {
  if (!token?.accessToken) return;
  const aad = `slack-connection:${connectionId}:${kind}`;
  await store.saveSlackCredential({
    connectionId,
    kind,
    tokenType: token.tokenType ?? null,
    accessTokenEnvelope: await cipher.encrypt(token.accessToken, `${aad}:access`),
    refreshTokenEnvelope: token.refreshToken ? await cipher.encrypt(token.refreshToken, `${aad}:refresh`) : null,
    expiresAt: token.expiresIn ? new Date(now.getTime() + token.expiresIn * 1000) : null,
    scopes: token.scope ?? null
  });
}
