import "server-only";

import type { SlackForwardingCredentialProvider } from "../slack/forwarding-credentials";
import type { SlackWebApiClient } from "../slack/web-api-client";
import { fetchAllGrantedSlackTeams } from "../slack/organization-workspaces";
import { PLAYTEST_SLACK_DIRECTORY_READ_POLICY } from "./policy";

export const PLAYTEST_DIRECTORY_CONTRACT_VERSION = PLAYTEST_SLACK_DIRECTORY_READ_POLICY.version;
const WORKSPACE_SYNC_TTL_MS = 5 * 60 * 1000;
const CHANNEL_CACHE_TTL_MS = 2 * 60 * 1000;

export type DirectoryConnection = {
  connectionId: string;
  installationScope: "workspace" | "organization";
  teamId: string | null;
  teamName: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
  grantsVerifiedAt: Date | null;
};

export type DirectoryWorkspace = {
  teamId: string;
  teamName: string | null;
  installationScope: "workspace" | "organization";
  enterpriseName: string | null;
  lastVerifiedAt: Date;
};

export type DirectoryChannel = {
  channelId: string;
  channelName: string;
  isPrivate: boolean;
};

export type PlaytestDirectoryStore = {
  /** Only the connection bound into the authenticated first-party token. */
  listConnections(input: { prismUserId: string; slackConnectionId: string }): Promise<DirectoryConnection[]>;
  replaceOrganizationGrants(input: {
    connectionId: string;
    teams: Array<{ teamId: string; teamName: string | null }>;
    verifiedAt: Date;
  }): Promise<void>;
  listWorkspaces(input: { prismUserId: string; slackConnectionId: string }): Promise<DirectoryWorkspace[]>;
  /** Re-check the target against the currently authorized connection before cache use. */
  resolveConnection(input: { prismUserId: string; slackConnectionId: string; teamId: string }): Promise<{ connectionId: string } | null>;
};

export type DirectoryResult<T> =
  | { kind: "ok"; value: T; cache: "hit" | "miss" | "local" }
  | { kind: "not_found" | "credential_unavailable" | "provider_error"; error: string };

type ChannelCacheEntry = { expiresAt: number; value: { channels: DirectoryChannel[]; nextCursor: string } };
const channelCache = new Map<string, ChannelCacheEntry>();

export async function listPlaytestWorkspaces(input: {
  prismUserId: string;
  slackConnectionId: string;
  store: PlaytestDirectoryStore;
  credentialProvider: SlackForwardingCredentialProvider;
  slackClient: SlackWebApiClient;
  refresh?: boolean;
  now?: Date;
}): Promise<DirectoryResult<DirectoryWorkspace[]>> {
  const now = input.now ?? new Date();
  const connectionScope = { prismUserId: input.prismUserId, slackConnectionId: input.slackConnectionId };
  const connections = await input.store.listConnections(connectionScope);
  for (const connection of connections) {
    if (connection.installationScope !== "organization") continue;
    const fresh = connection.grantsVerifiedAt && now.getTime() - connection.grantsVerifiedAt.getTime() < WORKSPACE_SYNC_TTL_MS;
    if (!input.refresh && fresh) continue;

    const credential = await input.credentialProvider.getAccessToken({ connectionId: connection.connectionId, kind: "user" });
    if (credential.kind !== "available") {
      if (connection.grantsVerifiedAt) continue;
      return { kind: "credential_unavailable", error: credential.errorClass };
    }
    const teams = await fetchAllGrantedSlackTeams(input.slackClient, credential.accessToken);
    if (teams.kind !== "ok") {
      if (connection.grantsVerifiedAt) continue;
      return teams;
    }
    await input.store.replaceOrganizationGrants({ connectionId: connection.connectionId, teams: teams.teams, verifiedAt: now });
  }
  return { kind: "ok", value: await input.store.listWorkspaces(connectionScope), cache: "local" };
}

export async function listPlaytestChannels(input: {
  prismUserId: string;
  slackConnectionId: string;
  teamId: string;
  cursor: string;
  limit: number;
  store: PlaytestDirectoryStore;
  credentialProvider: SlackForwardingCredentialProvider;
  slackClient: SlackWebApiClient;
  refresh?: boolean;
  now?: Date;
}): Promise<DirectoryResult<{ channels: DirectoryChannel[]; nextCursor: string }>> {
  const now = input.now ?? new Date();
  // Authorize every read before returning cached data. A cached page may never
  // outlive a connection revocation or workspace-grant revocation.
  const connection = await input.store.resolveConnection({
    prismUserId: input.prismUserId,
    slackConnectionId: input.slackConnectionId,
    teamId: input.teamId
  });
  if (!connection) return { kind: "not_found", error: "workspace_not_granted" };
  const cacheKey = `${input.prismUserId}:${input.slackConnectionId}:${input.teamId}:${input.cursor}:${input.limit}`;
  const cached = channelCache.get(cacheKey);
  if (!input.refresh && cached && cached.expiresAt > now.getTime()) return { kind: "ok", value: cached.value, cache: "hit" };
  const credential = await input.credentialProvider.getAccessToken({ connectionId: connection.connectionId, kind: "user" });
  if (credential.kind !== "available") {
    return cached ? { kind: "ok", value: cached.value, cache: "hit" } : { kind: "credential_unavailable", error: credential.errorClass };
  }
  const upstream = await input.slackClient.callMethod({
    method: "users.conversations",
    httpMethod: "GET",
    executionMode: "user",
    accessToken: credential.accessToken,
    payload: {
      team_id: input.teamId,
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {})
    }
  });
  const parsed = parseChannels(upstream.body);
  if (!parsed) return cached ? { kind: "ok", value: cached.value, cache: "hit" } : { kind: "provider_error", error: slackError(upstream.body) };
  channelCache.set(cacheKey, { value: parsed, expiresAt: now.getTime() + CHANNEL_CACHE_TTL_MS });
  return { kind: "ok", value: parsed, cache: "miss" };
}

function parseChannels(value: unknown): { channels: DirectoryChannel[]; nextCursor: string } | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.channels)) return null;
  const channels: DirectoryChannel[] = [];
  for (const candidate of value.channels) {
    if (!isRecord(candidate) || !validChannelId(candidate.id) || typeof candidate.name !== "string" || candidate.is_archived === true) continue;
    channels.push({ channelId: candidate.id, channelName: candidate.name.slice(0, 255), isPrivate: candidate.is_private === true });
  }
  const cursor = strictNextCursor(value);
  return cursor === null ? null : { channels, nextCursor: cursor };
}

function strictNextCursor(value: Record<string, unknown>): string | null {
  if (value.response_metadata === undefined) return "";
  if (!isRecord(value.response_metadata)) return null;
  const cursor = value.response_metadata.next_cursor;
  return typeof cursor === "string" && cursor.length <= 2048 ? cursor : null;
}

function slackError(value: unknown): string {
  return isRecord(value) && typeof value.error === "string" ? value.error.slice(0, 120) : "slack_directory_unavailable";
}

function validChannelId(value: unknown): value is string { return typeof value === "string" && /^[CG][A-Z0-9]{2,31}$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
