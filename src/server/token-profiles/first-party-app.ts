import "server-only";

import type { DeveloperTokenConfig, DeveloperTokenVerifier } from "./developer-token";
import { hashDeveloperToken, issueDeveloperToken } from "./developer-token";
import type { CapabilityMap } from "./presets";
import {
  buildCurrentGlobalTokenProfilePolicy,
  validateRequestedTokenProfilePolicy
} from "./global-policy";
import type { GlobalTokenProfilePolicyStore } from "./global-policy-store";

export const PLAYTEST_APP_CLIENT_ID = "shg-playtest";
export const PLAYTEST_APP_PROFILE_NAME = "shg_playtest_app";
export const PLAYTEST_APP_TOKEN_TTL_SECONDS = 8 * 60 * 60;

export const PLAYTEST_APP_CAPABILITY_MAP: CapabilityMap = {
  version: 1,
  preset: "custom",
  workspaces: { mode: "linked_slack_connection" },
  surfaces: {
    publicChannels: true,
    privateChannels: true,
    directMessages: false,
    groupDirectMessages: false,
    search: false,
    filesMetadata: false,
    canvases: false,
    lists: false,
    future: false
  },
  actions: {
    read: false,
    search: false,
    writeMessages: true,
    reactions: false,
    filesMetadata: false,
    destructive: false
  },
  executionIdentity: "user",
  experiment: { enabled: false, ttl: null },
  mutation: {
    destructiveOptIn: false,
    narrowingAppliesImmediately: true,
    broadeningRequiresRotation: true
  },
  deferred: {
    admin: false,
    fileTransfer: false,
    events: false,
    slashCommands: false,
    interactivity: false,
    canvases: false,
    lists: false
  }
};

export type FirstPartyAppTokenStore = {
  issuePlaytestAppToken(input: {
    prismUserId: string;
    slackConnectionId: string;
    verifier: DeveloperTokenVerifier;
    expiresAt: Date;
    now: Date;
    requestId: string;
  }): Promise<{ profileId: string } | null>;
};

export type PlaytestAppCredential = {
  token: string;
  expiresIn: number;
  profileId: string;
};

export async function issuePlaytestAppCredential(input: {
  store: FirstPartyAppTokenStore;
  developerTokenConfig: DeveloperTokenConfig;
  globalPolicyStore?: Pick<GlobalTokenProfilePolicyStore, "readGlobalTokenProfilePolicy">;
  prismUserId: string;
  slackConnectionId: string;
  requestId: string;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<PlaytestAppCredential | null> {
  const now = input.now ?? new Date();
  const policy = input.globalPolicyStore
    ? (await input.globalPolicyStore.readGlobalTokenProfilePolicy()).policy
    : buildCurrentGlobalTokenProfilePolicy();
  const expiresAt = new Date(now.getTime() + PLAYTEST_APP_TOKEN_TTL_SECONDS * 1000);
  const policyDecision = validateRequestedTokenProfilePolicy({
    input: { preset: "custom", executionIdentity: "user" },
    capabilityMap: PLAYTEST_APP_CAPABILITY_MAP,
    expiresAt,
    policyEffectiveAt: now,
    policy
  });
  if (policyDecision.kind !== "allowed") return null;
  const token = issueDeveloperToken({ randomBytes: input.randomBytes });
  const issued = await input.store.issuePlaytestAppToken({
    prismUserId: input.prismUserId,
    slackConnectionId: input.slackConnectionId,
    verifier: hashDeveloperToken(token, input.developerTokenConfig),
    expiresAt,
    now,
    requestId: input.requestId
  });
  return issued ? { token, expiresIn: PLAYTEST_APP_TOKEN_TTL_SECONDS, profileId: issued.profileId } : null;
}
