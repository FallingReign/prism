import "server-only";

import type { CredentialCipher } from "../credentials/encryption";
import { refreshSlackCredential, type RefreshStore } from "./refresh";
import type { SlackOAuthClient } from "./oauth-client";

export type SlackForwardingCredentialProvider = {
  getAccessToken(input: {
    connectionId: string | null | undefined;
    kind: "bot" | "user";
  }): Promise<{ kind: "available"; accessToken: string } | { kind: "unavailable"; error: "not_authed"; errorClass: string }>;
};

export function createSlackForwardingCredentialProvider({
  store,
  cipher,
  slackOAuthClient,
  now = () => new Date(),
  refreshSkewMs = 60_000
}: {
  store: RefreshStore;
  cipher: CredentialCipher;
  slackOAuthClient?: SlackOAuthClient;
  now?: () => Date;
  refreshSkewMs?: number;
}): SlackForwardingCredentialProvider {
  return {
    async getAccessToken({ connectionId, kind }) {
      if (!connectionId) return unavailable("missing_slack_connection");
      let credential = await store.getCredentialForRefresh({ connectionId, kind });
      if (!credential) return unavailable("missing_slack_credential");

      const currentTime = now();
      if (credential.expiresAt && credential.expiresAt.getTime() <= currentTime.getTime() + refreshSkewMs) {
        if (!slackOAuthClient) return unavailable("slack_credential_expired");
        try {
          const refresh = await refreshSlackCredential({ store, cipher, slackOAuthClient, connectionId, kind, now: currentTime });
          if (refresh.status === "reauth_required") return unavailable("slack_reauth_required");
          if (refresh.status !== "refreshed") return unavailable("slack_refresh_unavailable");
          credential = await store.getCredentialForRefresh({ connectionId, kind });
        } catch {
          return unavailable("slack_refresh_failed");
        }
        if (!credential) return unavailable("missing_slack_credential");
      }

      try {
        const accessToken = await cipher.decrypt(credential.accessTokenEnvelope, `slack-connection:${connectionId}:${kind}:access`);
        return { kind: "available", accessToken };
      } catch {
        return unavailable("credential_decryption_failed");
      }
    }
  };
}

function unavailable(errorClass: string): { kind: "unavailable"; error: "not_authed"; errorClass: string } {
  return { kind: "unavailable", error: "not_authed", errorClass };
}
