import "server-only";

export type SlackWorkspaceGrantDisplay = {
  teamId: string;
  teamName: string | null;
};

export function parseSlackWorkspaceGrantDisplay(value: unknown): SlackWorkspaceGrantDisplay[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const grants: SlackWorkspaceGrantDisplay[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const teamId = typeof row.team_id === "string" ? row.team_id.trim() : "";
    if (!/^T[A-Z0-9]{2,31}$/.test(teamId) || seen.has(teamId)) continue;
    const teamName = typeof row.team_name === "string" ? row.team_name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    seen.add(teamId);
    grants.push({ teamId, teamName: teamName || null });
  }

  return grants;
}
