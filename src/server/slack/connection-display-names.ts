import "server-only";

import type { SlackForwardingCredentialProvider } from "./forwarding-credentials";
import type { SlackWebApiClient } from "./web-api-client";

export type SlackConnectionDisplayRecord = {
  connectionId: string;
  status: "healthy" | "reauth_required";
  teamId: string | null;
  teamName: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
  slackUserId: string;
  slackUserDisplayName: string | null;
  displayNamesEnrichedAt: Date | null;
  lastErrorClass: string | null;
};

export type SlackConnectionDisplayNameStore = {
  updateConnectionDisplayNames(input: {
    connectionId: string;
    teamName: string | null;
    enterpriseName: string | null;
    slackUserDisplayName: string | null;
    enrichedAt: Date;
  }): Promise<SlackConnectionDisplayRecord>;
};

type SlackLookupKind = "user" | "bot";

export async function enrichSlackConnectionDisplayNames({
  connection,
  store,
  credentialProvider,
  webApiClient,
  now = new Date()
}: {
  connection: SlackConnectionDisplayRecord;
  store: SlackConnectionDisplayNameStore;
  credentialProvider: SlackForwardingCredentialProvider;
  webApiClient: SlackWebApiClient;
  now?: Date;
}): Promise<SlackConnectionDisplayRecord> {
  if (!needsSlackConnectionDisplayNameEnrichment(connection)) return connection;

  const found: {
    teamName: string | null;
    enterpriseName: string | null;
    slackUserDisplayName: string | null;
  } = {
    teamName: connection.teamName,
    enterpriseName: connection.enterpriseName,
    slackUserDisplayName: connection.slackUserDisplayName
  };
  let fallbackSlackUserDisplayName = found.slackUserDisplayName;
  let profileUserDisplayNameFound = Boolean(found.slackUserDisplayName);

  for (const kind of preferredCredentialKinds) {
    const credential = await credentialProvider.getAccessToken({ connectionId: connection.connectionId, kind });
    if (credential.kind !== "available") continue;

    const authTest = await callSlack(webApiClient, {
      accessToken: credential.accessToken,
      executionMode: kind,
      method: "auth.test",
      payload: {}
    });
    if (authTest?.ok) {
      found.teamName ??= connection.teamId && authTest.team_id === connection.teamId ? cleanDisplayName(authTest.team) : null;
      found.enterpriseName ??= enterpriseDisplayName(authTest, connection);
      fallbackSlackUserDisplayName ??= authTest.user_id === connection.slackUserId ? cleanDisplayName(authTest.user) : null;
    }

    const userInfo = await callSlack(webApiClient, {
      accessToken: credential.accessToken,
      executionMode: kind,
      method: "users.info",
      payload: { user: connection.slackUserId }
    });
    if (userInfo?.ok) {
      const profileDisplayName = userDisplayName(userInfo);
      if (profileDisplayName) {
        found.slackUserDisplayName = profileDisplayName;
        profileUserDisplayNameFound = true;
      }
    }

    if ((found.teamName || found.enterpriseName) && profileUserDisplayNameFound) break;
  }
  found.slackUserDisplayName ??= fallbackSlackUserDisplayName;

  return store.updateConnectionDisplayNames({
    connectionId: connection.connectionId,
    teamName: found.teamName,
    enterpriseName: found.enterpriseName,
    slackUserDisplayName: found.slackUserDisplayName,
    enrichedAt: now
  });
}

export function needsSlackConnectionDisplayNameEnrichment(connection: SlackConnectionDisplayRecord): boolean {
  if (connection.displayNamesEnrichedAt) return false;
  if (connection.status !== "healthy") return false;
  return Boolean((connection.teamId && !connection.teamName) || (connection.enterpriseId && !connection.enterpriseName) || !connection.slackUserDisplayName);
}

const preferredCredentialKinds: SlackLookupKind[] = ["user", "bot"];

async function callSlack(
  webApiClient: SlackWebApiClient,
  input: { method: string; payload: Record<string, unknown>; accessToken: string; executionMode: SlackLookupKind }
): Promise<Record<string, unknown> | null> {
  const result = await webApiClient.callMethod({
    method: input.method,
    httpMethod: "GET",
    payloadEncoding: "query",
    payload: input.payload,
    executionMode: input.executionMode,
    accessToken: input.accessToken
  });
  if (result.status < 200 || result.status >= 300 || !isObject(result.body)) return null;
  return result.body;
}

function userDisplayName(body: Record<string, unknown>): string | null {
  if (!isObject(body.user)) return null;
  const profile = isObject(body.user.profile) ? body.user.profile : {};
  return (
    cleanDisplayName(profile.display_name_normalized) ??
    cleanDisplayName(profile.display_name) ??
    cleanDisplayName(profile.real_name_normalized) ??
    cleanDisplayName(body.user.real_name) ??
    cleanDisplayName(body.user.name)
  );
}

function enterpriseDisplayName(body: Record<string, unknown>, connection: SlackConnectionDisplayRecord): string | null {
  if (!connection.enterpriseId) return null;
  const enterprise = isObject(body.enterprise) ? body.enterprise : {};
  const explicitName = cleanDisplayName(body.enterprise_name) ?? cleanDisplayName(enterprise.name);
  if (explicitName && (!body.enterprise_id || body.enterprise_id === connection.enterpriseId)) return explicitName;

  if (!connection.teamId && (body.team_id === connection.enterpriseId || body.enterprise_id === connection.enterpriseId)) {
    return cleanDisplayName(body.team);
  }
  return null;
}

function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed || containsSecretShape(trimmed)) return null;
  return trimmed.slice(0, 80);
}

function containsSecretShape(value: string): boolean {
  return /prism_dev_[A-Za-z0-9_-]+|xox[a-z]-[A-Za-z0-9-]+|access[_-]?token|client[_-]?secret|tokenHash|pepper|refresh[_-]?secret|authorization/i.test(
    value
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
