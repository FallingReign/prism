import "server-only";

import { PLAYTEST_APP_CLIENT_ID, PLAYTEST_APP_PROFILE_NAME } from "../token-profiles/first-party-app";
import type { ResolvedDeveloperToken } from "../token-profiles/local-tool-status";

/**
 * This is intentionally separate from the generic Slack method capability map.
 * The directory endpoints are a narrow, first-party resource API, not a Slack
 * method proxy.  Keeping the policy versioned makes an incompatible expansion
 * an explicit contract change instead of an accidental consequence of a token
 * that happens to have read scopes.
 */
export const PLAYTEST_SLACK_DIRECTORY_READ_POLICY = {
  version: 1,
  capability: "playtest.slack.directory.read",
  clientId: PLAYTEST_APP_CLIENT_ID,
  tokenProfileName: PLAYTEST_APP_PROFILE_NAME,
  connectionBinding: "issued_slack_connection",
  requiredCredential: "user"
} as const;

export type PlaytestDirectoryAuthorizedToken = ResolvedDeveloperToken & {
  prismUserId: string;
  slackConnectionId: string;
};

export function hasPlaytestSlackDirectoryReadPolicy(token: ResolvedDeveloperToken): token is PlaytestDirectoryAuthorizedToken {
  return token.clientId === PLAYTEST_SLACK_DIRECTORY_READ_POLICY.clientId
    && token.tokenProfileName === PLAYTEST_SLACK_DIRECTORY_READ_POLICY.tokenProfileName
    && Boolean(token.prismUserId)
    && Boolean(token.slackConnectionId)
    && token.slackStatus === "healthy"
    && token.hasUserCredential;
}
