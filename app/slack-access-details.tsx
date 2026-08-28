import type { SlackWorkspaceGrantDisplay } from "../src/server/slack/workspace-grant-display";
import { displayNameWithId } from "./slack-connection-display";
import { StatusBadge } from "./ui";

export type SlackAccessDetailsInput = {
  installationScope?: "workspace" | "organization";
  teamId: string | null;
  teamName?: string | null;
  enterpriseId?: string | null;
  enterpriseName?: string | null;
  workspaceGrants?: SlackWorkspaceGrantDisplay[];
};

export function SlackAccessDetails({ access, compact = false }: { access: SlackAccessDetailsInput; compact?: boolean }) {
  const installationScope = access.installationScope ?? (access.teamId ? "workspace" : "organization");
  const workspaceGrants = access.workspaceGrants ?? [];

  if (installationScope === "workspace") {
    const workspace = access.teamId ? displayNameWithId(access.teamName, access.teamId) : "Unknown workspace";
    return (
      <div className={compact ? "mt-3 border-t border-foreground/10 pt-3" : "grid gap-2"}>
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm text-foreground">Slack installation</strong>
          <StatusBadge tone="info">Workspace only</StatusBadge>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          Prism can access only <strong className="break-words text-foreground">{workspace}</strong> through this Slack connection.
          To use multiple workspaces, choose <strong className="text-foreground">Change Slack authorization</strong> and select the
          Enterprise Grid organization—not an individual workspace—then add Prism to the required workspaces in Slack organization app management.
        </p>
      </div>
    );
  }

  const organization = access.enterpriseId
    ? displayNameWithId(access.enterpriseName, access.enterpriseId)
    : "Slack organization";
  return (
    <div className={compact ? "mt-3 border-t border-foreground/10 pt-3" : "grid gap-2"}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm text-foreground">Slack installation</strong>
        <StatusBadge tone="primary">Organization</StatusBadge>
        <StatusBadge tone={workspaceGrants.length > 0 ? "success" : "warning"}>
          {workspaceGrants.length} granted {workspaceGrants.length === 1 ? "workspace" : "workspaces"}
        </StatusBadge>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        <strong className="break-words text-foreground">{organization}</strong> approved Prism at organization level. Prism can act
        only in the explicitly granted workspaces listed below.
      </p>
      {workspaceGrants.length > 0 ? (
        <ul className="grid max-h-44 gap-1 overflow-y-auto pr-2 text-sm text-muted-foreground" aria-label="Effective Slack workspace grants">
          {workspaceGrants.map((workspace) => (
            <li key={workspace.teamId} className="break-words">
              {displayNameWithId(workspace.teamName, workspace.teamId)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm font-medium leading-6 text-[color:var(--prism-warning)]">
          No workspaces are currently granted to this organization connection.
        </p>
      )}
      <p className="text-sm leading-6 text-muted-foreground">
        If an expected workspace is missing, add Prism to that workspace in Slack organization app management, then reload the
        workspace list in Playtest.
      </p>
    </div>
  );
}
