import "server-only";

import type { SlackWebApiClient, SlackWebApiResult } from "./web-api-client";

export type SlackOrganizationWorkspace = { teamId: string; teamName: string | null };

export type OrganizationWorkspaceDiscoveryResult =
  | { kind: "ok"; teams: SlackOrganizationWorkspace[] }
  | { kind: "provider_error"; error: string };

export async function fetchAllGrantedSlackTeams(
  client: SlackWebApiClient,
  accessToken: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {}
): Promise<OrganizationWorkspaceDiscoveryResult> {
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 60_000));
  const teams = new Map<string, string | null>();
  let cursor = "";
  const seenCursors = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { kind: "provider_error", error: "workspace_discovery_timeout" };
    const result = await callSlackWithTimeout(client, {
      method: "auth.teams.list",
      httpMethod: "GET",
      executionMode: "user",
      accessToken,
      timeoutMs: remainingMs,
      payload: { limit: 200, ...(cursor ? { cursor } : {}) }
    }, remainingMs);
    if (result === "timeout") return { kind: "provider_error", error: "workspace_discovery_timeout" };
    if (result === "provider_error") return { kind: "provider_error", error: "slack_directory_unavailable" };
    const parsed = parseTeams(result.body);
    if (!parsed) return { kind: "provider_error", error: slackError(result.body) };
    for (const team of parsed.teams) teams.set(team.teamId, team.teamName);
    cursor = parsed.nextCursor;
    if (!cursor) return { kind: "ok", teams: [...teams].map(([teamId, teamName]) => ({ teamId, teamName })) };
    if (seenCursors.has(cursor)) return { kind: "provider_error", error: "workspace_pagination_loop" };
    seenCursors.add(cursor);
  }
  return { kind: "provider_error", error: "workspace_pagination_limit" };
}

async function callSlackWithTimeout(
  client: SlackWebApiClient,
  input: Parameters<SlackWebApiClient["callMethod"]>[0],
  timeoutMs: number
): Promise<SlackWebApiResult | "timeout" | "provider_error"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.callMethod(input).catch(() => "provider_error" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseTeams(value: unknown): { teams: SlackOrganizationWorkspace[]; nextCursor: string } | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.teams)) return null;
  const teams: SlackOrganizationWorkspace[] = [];
  for (const candidate of value.teams) {
    if (!isRecord(candidate) || !validTeamId(candidate.id)) return null;
    teams.push({ teamId: candidate.id, teamName: boundedName(candidate.name) });
  }
  if (!isRecord(value.response_metadata)) return null;
  const cursor = strictNextCursor(value);
  return cursor === null ? null : { teams, nextCursor: cursor };
}

function strictNextCursor(value: Record<string, unknown>): string | null {
  if (!isRecord(value.response_metadata)) return null;
  const cursor = value.response_metadata.next_cursor;
  return typeof cursor === "string" && cursor.length <= 2048 ? cursor : null;
}

function slackError(value: unknown): string {
  return isRecord(value) && typeof value.error === "string" ? value.error.slice(0, 120) : "slack_directory_unavailable";
}

function validTeamId(value: unknown): value is string {
  return typeof value === "string" && /^T[A-Z0-9]{2,31}$/.test(value);
}

function boundedName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 255) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
