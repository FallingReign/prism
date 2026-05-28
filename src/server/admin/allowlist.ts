import "server-only";

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { AdminAllowlist, AdminAllowlistEntry, AdminScope } from "./authorization";

export const defaultAdminAllowlistPath = "config/prism-admin-allowlist.local.json";
const defaultAdminAllowlistFileName = "prism-admin-allowlist.local.json";

export class AdminAllowlistUnavailableError extends Error {
  constructor() {
    super("admin-allowlist-unavailable");
  }
}

export async function loadAdminAllowlist(env: NodeJS.ProcessEnv = process.env): Promise<AdminAllowlist> {
  const path = adminAllowlistPath(env);
  try {
    return parseAdminAllowlistContent(await readFile(/*turbopackIgnore: true*/ path, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) return { entries: [] };
    if (error instanceof AdminAllowlistUnavailableError) throw error;
    throw new AdminAllowlistUnavailableError();
  }
}

export function parseAdminAllowlistContent(content: string): AdminAllowlist {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AdminAllowlistUnavailableError();
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.admins)) throw new AdminAllowlistUnavailableError();
  return { entries: parsed.admins.map(parseEntry) };
}

function adminAllowlistPath(env: NodeJS.ProcessEnv): string {
  const configured = env.PRISM_ADMIN_ALLOWLIST_PATH?.trim();
  if (!configured) return join(/*turbopackIgnore: true*/ process.cwd(), "config", defaultAdminAllowlistFileName);
  if (isAbsolute(configured)) return configured;
  return join(/*turbopackIgnore: true*/ process.cwd(), "config", configured.replace(/^config[\\/]/, ""));
}

function parseEntry(value: unknown): AdminAllowlistEntry {
  if (!isRecord(value)) throw new AdminAllowlistUnavailableError();
  const slackUserId = trimmedString(value.slackUserId);
  if (!slackUserId) throw new AdminAllowlistUnavailableError();
  return { slackUserId, scope: parseScope(value.scope) };
}

function parseScope(value: unknown): AdminScope {
  if (!isRecord(value)) throw new AdminAllowlistUnavailableError();
  if (value.kind === "global") return { kind: "global" };
  if (value.kind === "enterprise") {
    const enterpriseId = trimmedString(value.enterpriseId);
    if (!enterpriseId) throw new AdminAllowlistUnavailableError();
    return { kind: "enterprise", enterpriseId };
  }
  if (value.kind === "team") {
    const teamId = trimmedString(value.teamId);
    if (!teamId) throw new AdminAllowlistUnavailableError();
    return { kind: "team", teamId };
  }
  throw new AdminAllowlistUnavailableError();
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
