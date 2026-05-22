import "server-only";

import type { CredentialCipher, CredentialEnvelope } from "../credentials/encryption";
import type { SlackOAuthClient, SlackOAuthFailure, SlackOAuthSuccess } from "./oauth-client";

export type RefreshStore = {
  getCredentialForRefresh(input: {
    connectionId: string;
    kind: "bot" | "user";
  }): Promise<{
    connectionId: string;
    kind: "bot" | "user";
    tokenType: string | null;
    accessTokenEnvelope: CredentialEnvelope;
    refreshTokenEnvelope: CredentialEnvelope | null;
    expiresAt: Date | null;
    scopes: string | null;
  } | null>;
  saveRefreshedCredential(input: {
    connectionId: string;
    kind: "bot" | "user";
    tokenType: string | null;
    accessTokenEnvelope: CredentialEnvelope;
    refreshTokenEnvelope: CredentialEnvelope | null;
    expiresAt: Date | null;
    scopes: string | null;
  }): Promise<void>;
  markConnectionHealthy(connectionId: string): Promise<void>;
  markConnectionReauthRequired(connectionId: string, errorClass: string): Promise<void>;
};

export async function refreshSlackCredential({
  store,
  cipher,
  slackOAuthClient,
  connectionId,
  kind,
  now = new Date()
}: {
  store: RefreshStore;
  cipher: CredentialCipher;
  slackOAuthClient: SlackOAuthClient;
  connectionId: string;
  kind: "bot" | "user";
  now?: Date;
}): Promise<{ status: "refreshed" | "reauth_required" | "unchanged" }> {
  const current = await store.getCredentialForRefresh({ connectionId, kind });
  if (!current?.refreshTokenEnvelope) {
    await store.markConnectionReauthRequired(connectionId, "missing_refresh_token");
    return { status: "reauth_required" };
  }

  const aad = `slack-connection:${connectionId}:${kind}`;
  const refreshToken = await cipher.decrypt(current.refreshTokenEnvelope, `${aad}:refresh`);
  const result = await slackOAuthClient.refreshToken({ refreshToken, kind });

  if (!result.ok) {
    if (isReauthFailure(result.errorClass)) {
      await store.markConnectionReauthRequired(connectionId, result.errorClass);
      return { status: "reauth_required" };
    }
    return { status: "unchanged" };
  }

  const token = tokenForKind(result, kind);
  if (!token?.accessToken) {
    await store.markConnectionReauthRequired(connectionId, "missing_access_token");
    return { status: "reauth_required" };
  }

  await store.saveRefreshedCredential({
    connectionId,
    kind,
    tokenType: token.tokenType ?? current.tokenType,
    accessTokenEnvelope: await cipher.encrypt(token.accessToken, `${aad}:access`),
    refreshTokenEnvelope: token.refreshToken
      ? await cipher.encrypt(token.refreshToken, `${aad}:refresh`)
      : current.refreshTokenEnvelope,
    expiresAt: token.expiresIn ? new Date(now.getTime() + token.expiresIn * 1000) : current.expiresAt,
    scopes: token.scope ?? current.scopes
  });
  await store.markConnectionHealthy(connectionId);
  return { status: "refreshed" };
}

function tokenForKind(result: SlackOAuthSuccess, kind: "bot" | "user"): SlackOAuthSuccess["bot"] | SlackOAuthSuccess["authedUser"] {
  return kind === "bot" ? result.bot : result.authedUser;
}

function isReauthFailure(errorClass: SlackOAuthFailure["errorClass"] | string): boolean {
  return errorClass === "invalid_refresh_token" || errorClass === "invalid_grant" || errorClass === "token_revoked";
}
