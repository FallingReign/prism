import "server-only";

import { getDeveloperTokenConfig } from "../config";
import type { DeveloperTokenConfig } from "../token-profiles/developer-token";
import { PLAYTEST_APP_CLIENT_ID, PLAYTEST_APP_PROFILE_NAME } from "../token-profiles/first-party-app";
import { resolvePresentedDeveloperToken, type LocalToolTokenStore } from "../token-profiles/local-tool-status";

export type PlaytestDirectoryIdentity = {
  prismUserId: string;
  tokenProfileId: string;
  slackConnectionId: string;
};

export async function authenticatePlaytestDirectory(input: {
  store: LocalToolTokenStore;
  authorization: string | null;
  requestId: string;
  now?: Date;
  developerTokenConfig?: DeveloperTokenConfig;
}): Promise<
  | { kind: "authenticated"; identity: PlaytestDirectoryIdentity }
  | { kind: "denied"; status: number; error: string }
> {
  const resolution = await resolvePresentedDeveloperToken({
    store: input.store,
    bearerToken: readBearerToken(input.authorization),
    developerTokenConfig: input.developerTokenConfig ?? getDeveloperTokenConfig(),
    requestId: input.requestId,
    now: input.now ?? new Date()
  });
  if (resolution.kind !== "active") {
    return { kind: "denied", status: resolution.result.httpStatus, error: "invalid_playtest_credential" };
  }
  const resolved = resolution.resolved;
  if (
    resolved.clientId !== PLAYTEST_APP_CLIENT_ID ||
    resolved.tokenProfileName !== PLAYTEST_APP_PROFILE_NAME ||
    !resolved.prismUserId ||
    !resolved.slackConnectionId ||
    resolved.slackStatus !== "healthy" ||
    !resolved.hasUserCredential
  ) {
    return { kind: "denied", status: 403, error: "playtest_directory_not_allowed" };
  }
  return {
    kind: "authenticated",
    identity: {
      prismUserId: resolved.prismUserId,
      tokenProfileId: resolved.tokenProfileId,
      slackConnectionId: resolved.slackConnectionId
    }
  };
}

function readBearerToken(authorization: string | null): string | undefined {
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}
