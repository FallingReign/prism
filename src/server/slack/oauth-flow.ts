import "server-only";

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

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
  saveOAuthState(input: { stateHash: string; redirectUri: string; expiresAt: Date }): Promise<void>;
  consumeOAuthState(input: { stateHash: string; now: Date }): Promise<{ redirectUri: string } | null>;
  upsertPrismUser(input: { slackTeamId: string; slackUserId: string; slackEnterpriseId: string | null }): Promise<{ id: string }>;
  upsertSlackConnection(input: {
    prismUserId: string;
    teamId: string;
    enterpriseId: string | null;
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
  now = new Date(),
  randomBytes = nodeRandomBytes
}: {
  store: OAuthFlowStore;
  config: SlackOAuthConfig;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<{ state: string; stateHash: string; redirectUrl: string; cookie: CookieSpec }> {
  const state = randomBytes(32).toString("base64url");
  const stateHash = hashSecret(state);
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  await store.saveOAuthState({ stateHash, redirectUri: config.redirectUri, expiresAt });

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
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<
  | { kind: "linked"; redirectUrl: string; sessionCookie: CookieSpec }
  | { kind: "invalid_state" | "slack_error"; redirectUrl: string; sessionCookie?: undefined }
> {
  if (!code || !state || !cookieState || state !== cookieState) {
    return { kind: "invalid_state", redirectUrl: statusRedirect(config, "error") };
  }

  const storedState = await store.consumeOAuthState({ stateHash: hashSecret(state), now });
  if (!storedState || storedState.redirectUri !== config.redirectUri) {
    return { kind: "invalid_state", redirectUrl: statusRedirect(config, "error") };
  }

  const slackResult = await slackOAuthClient.exchangeCode({ code, redirectUri: config.redirectUri });
  if (!slackResult.ok) {
    return { kind: "slack_error", redirectUrl: statusRedirect(config, "error") };
  }

  const prismUser = await store.upsertPrismUser({
    slackTeamId: slackResult.team.id,
    slackUserId: slackResult.authedUser.id,
    slackEnterpriseId: slackResult.enterprise?.id ?? null
  });
  const connection = await store.upsertSlackConnection({
    prismUserId: prismUser.id,
    teamId: slackResult.team.id,
    enterpriseId: slackResult.enterprise?.id ?? null,
    authedUserId: slackResult.authedUser.id,
    appId: slackResult.appId,
    botScopes: slackResult.bot?.scope ?? "",
    userScopes: slackResult.authedUser.scope ?? ""
  });

  await storeCredentialIfPresent({ store, cipher, connectionId: connection.id, kind: "bot", token: slackResult.bot, now });
  await storeCredentialIfPresent({ store, cipher, connectionId: connection.id, kind: "user", token: slackResult.authedUser, now });

  const sessionToken = randomBytes(32).toString("base64url");
  await store.createWebsiteSession({
    sessionTokenHash: hashSecret(sessionToken),
    prismUserId: prismUser.id,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  });

  return {
    kind: "linked",
    redirectUrl: statusRedirect(config, "linked"),
    sessionCookie: sessionCookie(sessionToken, config.publicBaseUrl)
  };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
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
