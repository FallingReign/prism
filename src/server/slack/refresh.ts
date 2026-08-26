import "server-only";

import type { CredentialCipher, CredentialEnvelope } from "../credentials/encryption";
import type { SlackOAuthClient, SlackOAuthFailure } from "./oauth-client";

export type RefreshStore = {
  withCredentialRefreshLock?<T>(
    input: { connectionId: string; kind: "bot" | "user" },
    callback: (lockedStore: RefreshStore) => Promise<T>
  ): Promise<T>;
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
}): Promise<
  | { status: "refreshed" }
  | { status: "reauth_required"; errorClass: string }
  | { status: "unavailable"; errorClass: string }
> {
  if (store.withCredentialRefreshLock) {
    return store.withCredentialRefreshLock({ connectionId, kind }, (lockedStore) =>
      refreshSlackCredentialUnlocked({ store: lockedStore, cipher, slackOAuthClient, connectionId, kind, now })
    );
  }
  return refreshSlackCredentialUnlocked({ store, cipher, slackOAuthClient, connectionId, kind, now });
}

async function refreshSlackCredentialUnlocked({
  store,
  cipher,
  slackOAuthClient,
  connectionId,
  kind,
  now
}: {
  store: RefreshStore;
  cipher: CredentialCipher;
  slackOAuthClient: SlackOAuthClient;
  connectionId: string;
  kind: "bot" | "user";
  now: Date;
}): Promise<
  | { status: "refreshed" }
  | { status: "reauth_required"; errorClass: string }
  | { status: "unavailable"; errorClass: string }
> {
  const current = await store.getCredentialForRefresh({ connectionId, kind });
  if (!current?.refreshTokenEnvelope) {
    await store.markConnectionReauthRequired(connectionId, "missing_refresh_token");
    return { status: "reauth_required", errorClass: "missing_refresh_token" };
  }

  // A concurrent request may have completed rotation while this caller waited
  // for the database-backed credential lock. Reuse the freshly persisted row.
  if (current.expiresAt && current.expiresAt.getTime() > now.getTime() + 60_000) {
    return { status: "refreshed" };
  }

  const aad = `slack-connection:${connectionId}:${kind}`;
  const refreshToken = await cipher.decrypt(current.refreshTokenEnvelope, `${aad}:refresh`);
  const result = await slackOAuthClient.refreshToken({ refreshToken, kind });

  if (!result.ok) {
    if (isReauthFailure(result.errorClass)) {
      await store.markConnectionReauthRequired(connectionId, result.errorClass);
      return { status: "reauth_required", errorClass: result.errorClass };
    }
    return { status: "unavailable", errorClass: result.errorClass };
  }

  const token = result.credential;

  await store.saveRefreshedCredential({
    connectionId,
    kind,
    tokenType: token.tokenType,
    accessTokenEnvelope: await cipher.encrypt(token.accessToken, `${aad}:access`),
    refreshTokenEnvelope: await cipher.encrypt(token.refreshToken, `${aad}:refresh`),
    expiresAt: new Date(now.getTime() + token.expiresIn * 1000),
    scopes: token.scope ?? current.scopes
  });
  await store.markConnectionHealthy(connectionId);
  return { status: "refreshed" };
}

function isReauthFailure(errorClass: SlackOAuthFailure["errorClass"] | string): boolean {
  return (
    errorClass === "invalid_refresh_token" ||
    errorClass === "invalid_grant" ||
    errorClass === "token_revoked" ||
    errorClass === "token_expired" ||
    errorClass === "account_inactive"
  );
}
