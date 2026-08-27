import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { authenticatePlaytestDirectory } from "../../../../../../../../src/server/playtest-directory/authentication";
import { listPlaytestChannels, PLAYTEST_DIRECTORY_CONTRACT_VERSION } from "../../../../../../../../src/server/playtest-directory/directory";
import { createPlaytestDirectoryRuntime } from "../../../../../../../../src/server/playtest-directory/runtime";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ teamId: string }> | { teamId: string } };

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = randomUUID();
  const { teamId } = await context.params;
  if (!/^T[A-Z0-9]{2,31}$/.test(teamId)) return json({ error: "invalid_workspace" }, 400, requestId);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? "";
  if (cursor.length > 2048) return json({ error: "invalid_cursor" }, 400, requestId);
  const requestedLimit = Number(url.searchParams.get("limit") ?? "200");
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 200 ? requestedLimit : 200;

  const runtime = await createPlaytestDirectoryRuntime();
  const auth = await authenticatePlaytestDirectory({
    store: runtime.authStore,
    authorization: request.headers.get("authorization"),
    requestId
  });
  if (auth.kind !== "authenticated") return json({ error: auth.error }, auth.status, requestId);
  const result = await listPlaytestChannels({
    prismUserId: auth.identity.prismUserId,
    teamId,
    cursor,
    limit,
    store: runtime.directoryStore,
    credentialProvider: runtime.credentialProvider,
    slackClient: runtime.slackClient,
    refresh: url.searchParams.get("refresh") === "true"
  });
  if (result.kind !== "ok") return json({ error: result.error }, result.kind === "not_found" ? 404 : 503, requestId);
  return json({
    contract_version: PLAYTEST_DIRECTORY_CONTRACT_VERSION,
    team_id: teamId,
    channels: result.value.channels.map((channel) => ({
      channel_id: channel.channelId,
      channel_name: channel.channelName,
      is_private: channel.isPrivate
    })),
    next_cursor: result.value.nextCursor
  }, 200, requestId, result.cache);
}

function json(body: unknown, status: number, requestId: string, cache?: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, max-age=60, stale-if-error=300");
  response.headers.set("X-Prism-Request-ID", requestId);
  if (cache) response.headers.set("X-Prism-Directory-Cache", cache);
  return response;
}
