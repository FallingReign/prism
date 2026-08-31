import "server-only";

import type { Database } from "../db";
import { getOwnerSlackContext } from "./slack-catalog";
import { buildRemoteCodexHomeView } from "./slack-projection";

type SlackCaller = {
  call(input: {
    ownerKey: string;
    connectionId: string;
    prismUserId: string;
    slackUserId: string;
    slackTeamId: string;
    method: string;
    payload: Record<string, unknown>;
    activityType: "remote_codex_app_home_published";
    surface: "app_home";
    objectType?: string;
    objectId?: string;
    requestId: string;
  }): Promise<{ kind: "ok"; body: unknown } | { kind: "unavailable"; error: string }>;
};

export async function publishRemoteCodexAppHome({
  database,
  slack,
  teamId,
  slackUserId,
  appId,
  requestId,
  connectUrl
}: {
  database: Database;
  slack: SlackCaller;
  teamId: string;
  slackUserId: string;
  appId: string;
  requestId: string;
  connectUrl: string;
}): Promise<"published" | "not_connected" | "unavailable"> {
  const catalog = await getOwnerSlackContext(database, { teamId, slackUserId, appId });
  if (!catalog.connectionId || !catalog.prismUserId) return "not_connected";
  const result = await slack.call({
    ownerKey: catalog.prismUserId,
    connectionId: catalog.connectionId,
    prismUserId: catalog.prismUserId,
    slackUserId,
    slackTeamId: teamId,
    method: "views.publish",
    payload: { user_id: slackUserId, view: buildRemoteCodexHomeView({ sessions: catalog.sessions, connectUrl }) },
    activityType: "remote_codex_app_home_published",
    surface: "app_home",
    objectType: "remote_codex_app_home",
    objectId: slackUserId,
    requestId
  });
  return result.kind === "ok" ? "published" : "unavailable";
}
