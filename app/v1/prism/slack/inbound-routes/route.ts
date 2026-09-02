import { randomBytes, randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { database } from "../../../../../src/server/db";
import { createInboundRoute } from "../../../../../src/server/slack/prism-inbox";
import { authenticatePrismInboxRequest, prismInboxJson, readJsonRecord } from "../../../../../src/server/slack/prism-inbox-http";
import { createPostgresPrismInboxStore } from "../../../../../src/server/slack/postgres-prism-inbox-store";
import { readSocketWorkerHealth } from "../../../../../src/server/slack/socket-worker";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const auth = await authenticatePrismInboxRequest(request, requestId);
  if (auth.kind === "response") return auth.response;
  const body = await readJsonRecord(request);
  const workspaceId = stringValue(body?.workspaceId);
  const channelId = stringValue(body?.channelId);
  const expiresInSeconds = numberValue(body?.expiresInSeconds, 600);
  if (!workspaceId || !channelId || body?.envelopeType !== "block_actions" || body?.actionType !== "static_select") {
    return prismInboxJson({ ok: false, error: "invalid_route", requestId }, 400, requestId);
  }

  const resolved = auth.resolved;
  if (!resolved.slackConnectionId || !resolved.slackUserId || resolved.slackStatus !== "healthy") {
    return prismInboxJson({ ok: false, error: "slack_connection_unavailable", requestId }, 409, requestId);
  }
  const socket = await readSocketWorkerHealth(database).catch(() => null);
  if (socket?.status !== "connected") {
    return prismInboxJson({ ok: false, error: "socket_unavailable", requestId }, 503, requestId);
  }
  if (!resolved.slackTeamId) {
    const allowed = await auth.tokenStore.isWorkspaceAllowed?.({ slackConnectionId: resolved.slackConnectionId, workspaceId });
    if (!allowed) return prismInboxJson({ ok: false, error: "workspace_denied", requestId }, 403, requestId);
  }

  const result = await createInboundRoute({
    store: createPostgresPrismInboxStore(database),
    owner: {
      tokenProfileId: resolved.tokenProfileId,
      slackConnectionId: resolved.slackConnectionId,
      slackUserId: resolved.slackUserId,
      slackTeamId: resolved.slackTeamId ?? null,
      slackEnterpriseId: resolved.slackEnterpriseId ?? null,
      blockActionsAllowed: resolved.capabilityMap.inbound?.blockActions === true
    },
    workspaceId,
    channelId,
    expiresInSeconds,
    now: new Date(),
    routeId: randomUUID(),
    routeKey: randomBytes(24).toString("base64url")
  });
  if (result.kind === "denied") return prismInboxJson({ ok: false, error: result.error, requestId }, result.error === "invalid_route" ? 400 : 403, requestId);
  return prismInboxJson({ ok: true, requestId, route: { id: result.routeId, key: result.routeKey, expiresAt: result.expiresAt.toISOString() } }, 201, requestId);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
