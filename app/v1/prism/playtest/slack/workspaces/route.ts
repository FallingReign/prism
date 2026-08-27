import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { authenticatePlaytestDirectory } from "../../../../../../src/server/playtest-directory/authentication";
import { listPlaytestWorkspaces, PLAYTEST_DIRECTORY_CONTRACT_VERSION } from "../../../../../../src/server/playtest-directory/directory";
import { createPlaytestDirectoryRuntime } from "../../../../../../src/server/playtest-directory/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const runtime = await createPlaytestDirectoryRuntime();
  const auth = await authenticatePlaytestDirectory({
    store: runtime.authStore,
    authorization: request.headers.get("authorization"),
    requestId
  });
  if (auth.kind !== "authenticated") return json({ error: auth.error }, auth.status, requestId);

  const result = await listPlaytestWorkspaces({
    prismUserId: auth.identity.prismUserId,
    slackConnectionId: auth.identity.slackConnectionId,
    store: runtime.directoryStore,
    credentialProvider: runtime.credentialProvider,
    slackClient: runtime.slackClient,
    refresh: new URL(request.url).searchParams.get("refresh") === "true"
  });
  if (result.kind !== "ok") return json({ error: result.error }, result.kind === "not_found" ? 404 : 503, requestId);
  return json({
    contract_version: PLAYTEST_DIRECTORY_CONTRACT_VERSION,
    workspaces: result.value.map((workspace) => ({
      team_id: workspace.teamId,
      team_name: workspace.teamName,
      grant_status: "active",
      installation_scope: workspace.installationScope,
      enterprise_name: workspace.enterpriseName,
      last_verified_at: workspace.lastVerifiedAt.toISOString()
    }))
  }, 200, requestId, result.cache);
}

function json(body: unknown, status: number, requestId: string, cache?: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, max-age=60, stale-if-error=300");
  response.headers.set("X-Prism-Request-ID", requestId);
  if (cache) response.headers.set("X-Prism-Directory-Cache", cache);
  return response;
}
