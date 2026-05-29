import type { AdminScope } from "../../../src/server/admin/authorization";
import type { AdminUserDetail, AdminUserDirectoryRow } from "../../../src/server/admin/user-directory";
import { ActivityAuditPanel } from "../../activity-audit-panel";
import { formatUtcDate, formatUtcDateTime } from "../../date-format";
import { displayNameWithId, safeConnectionText } from "../../slack-connection-display";
import { LinkButton, Panel, StatusBadge, SummaryMetric } from "../../ui";
import { AdminSlackConnectionActions } from "./admin-slack-connection-actions";
import { AdminTokenProfileActions } from "./admin-token-profile-actions";

export function AdminUserDirectoryView({ scope, users }: { scope: AdminScope; users: AdminUserDirectoryRow[] }) {
  return (
    <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
      <AdminUsersHeader scope={scope} />
      <Panel
        title="Prism user directory"
        titleId="admin-user-directory-title"
        eyebrow="Scoped metadata"
        accent="primary"
        badge={<StatusBadge tone={users.length > 0 ? "success" : "neutral"}>{users.length > 0 ? `${users.length} visible` : "Empty scope"}</StatusBadge>}
      >
        {users.length === 0 ? (
          <div className="rounded-2xl bg-muted/35 p-4">
            <h3 className="text-base font-semibold tracking-tight text-foreground">No Prism users in this admin scope</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Prism lists Slack-authenticated users whose current or retained local metadata is inside your active admin scope.
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {users.map((user) => (
              <article key={user.prismUserId} className="grid gap-3 rounded-2xl border border-border bg-background/75 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold tracking-tight text-foreground [overflow-wrap:anywhere]">{slackUserLabel(user)}</h3>
                  <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <Metadata label="Scope" value={scopeLabelForUser(user)} />
                    <Metadata label="Connection" value={connectionStatusLabel(user)} />
                    <Metadata label="Token profiles" value={`${user.tokenProfiles.activeCount} active / ${user.tokenProfiles.revokedCount} removed`} />
                    <Metadata label="Latest activity" value={formatUtcDateTime(user.latestActivityAt) ?? "No activity"} />
                  </dl>
                </div>
                <LinkButton href={`/admin/users/${encodeURIComponent(user.prismUserId)}`} variant="secondary">
                  View detail
                </LinkButton>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </main>
  );
}

export function AdminUserDetailView({ scope, detail }: { scope: AdminScope; detail: AdminUserDetail }) {
  const user = detail.user;
  return (
    <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
      <AdminUsersHeader scope={scope} />
      <Panel
        title="Prism user detail"
        titleId="admin-user-detail-title"
        eyebrow="Scoped target"
        accent="primary"
        badge={<StatusBadge tone={connectionStatusTone(user)}>{connectionStatusLabel(user)}</StatusBadge>}
        actions={<LinkButton href="/admin/users" variant="secondary">Back to directory</LinkButton>}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryMetric label="Slack user" value={slackUserLabel(user)} detail={user.slackConnection.status === "not_linked" ? "Safe Slack identity retained after local disconnection." : "Safe Slack identity from the current local connection."} tone="primary" />
          <SummaryMetric label="Scope" value={scopeLabelForUser(user)} detail={user.slackConnection.status === "not_linked" ? "Retained Slack workspace or organization visibility." : "Current Slack workspace or organization visibility."} tone="info" />
          <SummaryMetric label="Token profiles" value={`${user.tokenProfiles.activeCount} active`} detail={`${user.tokenProfiles.revokedCount} removed profiles retained for review.`} tone="neutral" />
        </div>
        {user.slackConnection.lastErrorClass ? <p className="text-sm text-muted-foreground">Last connection error: {safeConnectionText(user.slackConnection.lastErrorClass)}</p> : null}
        {user.slackConnection.id ? (
          <AdminSlackConnectionActions userId={user.prismUserId} slackUserLabel={slackUserLabel(user)} />
        ) : (
          <p className="rounded-xl border border-border bg-muted/35 px-3 py-2 text-sm leading-6 text-muted-foreground">
            No current Slack connection is linked for this retained Prism user. Admin removal is unavailable until the user reconnects Slack.
          </p>
        )}
      </Panel>

      <Panel title="Visible retained Token profiles" titleId="admin-user-token-profiles-title" eyebrow="Read-only access review" accent="warning">
        {detail.profiles.length === 0 ? (
          <p>No visible retained Token profiles for the current in-scope Slack connection.</p>
        ) : (
          <div className="grid gap-3">
            {detail.profiles.map((profile) => (
              <article key={profile.id} className="rounded-xl bg-muted/35 p-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="min-w-0 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">{safeConnectionText(profile.name)}</h3>
                  <StatusBadge tone={profile.status === "revoked" ? "neutral" : "success"}>{profile.status ?? "active"}</StatusBadge>
                  <StatusBadge tone={profile.developerToken?.status === "active" ? "success" : "warning"}>{profile.developerToken?.status ?? "missing token"}</StatusBadge>
                </div>
                <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <Metadata label="Preset" value={profile.preset} />
                  <Metadata label="Execution" value={profile.executionIdentity} />
                  <Metadata label="Created" value={formatUtcDate(profile.createdAt)} />
                  <Metadata label="Last used" value={formatUtcDateTime(profile.developerToken?.lastUsedAt ?? null) ?? "Not used"} />
                </dl>
                <AdminTokenProfileActions userId={user.prismUserId} profile={profile} />
              </article>
            ))}
          </div>
        )}
      </Panel>

      <ActivityAuditPanel activity={detail.activity} />
    </main>
  );
}

function AdminUsersHeader({ scope }: { scope: AdminScope }) {
  return (
    <header className="grid gap-4 rounded-2xl bg-card/75 p-3 shadow-sm ring-1 ring-foreground/5 backdrop-blur sm:grid-cols-[auto_1fr_auto] sm:items-center">
      <a className="inline-flex items-center gap-3 rounded-xl text-foreground no-underline" href="/admin">
        <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm" aria-hidden="true">
          P
        </span>
        <span className="grid">
          <strong className="text-sm font-semibold leading-5">Prism admin</strong>
          <span className="text-xs text-muted-foreground">User directory</span>
        </span>
      </a>
      <nav className="flex flex-wrap gap-1 sm:justify-center" aria-label="Admin users">
        <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="/admin">
          Admin overview
        </a>
        <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="/admin/users">
          User directory
        </a>
        <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="/admin/token-profile-policy">
          Global policy
        </a>
      </nav>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <StatusBadge tone="success">{scope.kind}</StatusBadge>
        <LinkButton href="/" variant="secondary">
          Return to Prism
        </LinkButton>
      </div>
    </header>
  );
}

function Metadata({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="inline-flex min-w-0 items-baseline gap-1">
      <dt className="font-semibold uppercase tracking-[0.12em]">{label}: </dt>
      <dd className="min-w-0 font-mono text-foreground [overflow-wrap:anywhere]">{safeConnectionText(value)}</dd>
    </div>
  );
}

function slackUserLabel(user: AdminUserDirectoryRow): string {
  return displayNameWithId(user.slackUser.displayName, user.slackUser.id);
}

function scopeLabelForUser(user: AdminUserDirectoryRow): string {
  if (user.team) return displayNameWithId(user.team.name, user.team.id);
  if (user.enterprise) return displayNameWithId(user.enterprise.name, user.enterprise.id);
  return "Unknown Slack scope";
}

function connectionStatusLabel(user: AdminUserDirectoryRow): string {
  if (user.slackConnection.status === "healthy") return "Connected";
  if (user.slackConnection.status === "not_linked") return "Disconnected";
  return "Needs reauth";
}

function connectionStatusTone(user: AdminUserDirectoryRow): "success" | "warning" | "neutral" {
  if (user.slackConnection.status === "healthy") return "success";
  if (user.slackConnection.status === "not_linked") return "neutral";
  return "warning";
}
