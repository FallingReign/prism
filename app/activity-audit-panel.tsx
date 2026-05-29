import type { ActivityAuditSummary } from "../src/server/audit/presentation";
import { formatUtcDateTime } from "./date-format";
import { Notice, Panel, StatusBadge } from "./ui";

export function ActivityAuditPanel({ activity }: { activity: ActivityAuditSummary[] }) {
  return (
    <Panel
      className="activity-audit"
      title="Recent Prism activity"
      titleId="activity-audit-title"
      eyebrow="Activity audit"
      accent="info"
      badge={<StatusBadge tone={activity.length > 0 ? "info" : "neutral"}>{activity.length > 0 ? "Metadata events" : "No activity"}</StatusBadge>}
    >
      <Notice title="Metadata only" tone="info" className="px-3 py-2.5">
        This view stores metadata only: methods, policy outcomes, object identifiers, request IDs, and timestamps. Slack message text, search queries,
        file contents, and tokens are not stored.
      </Notice>
      {activity.length === 0 ? (
        <div className="grid gap-4 rounded-2xl bg-muted/30 p-4">
          <h3 className="text-base font-semibold tracking-tight text-foreground">No forwarded or blocked calls yet</h3>
          <p className="text-sm leading-6 text-muted-foreground">When a Token profile uses the Slack bridge, this workspace will list the metadata you can inspect safely.</p>
          <ul className="divide-y rounded-xl bg-background/70 px-3">
            <li className="py-3">
              <strong className="block text-sm text-foreground">Method and category</strong>
              <span className="mt-1 block text-sm leading-6 text-muted-foreground">Slack Web API method plus the policy category Prism evaluated.</span>
            </li>
            <li className="py-3">
              <strong className="block text-sm text-foreground">Outcome and request ID</strong>
              <span className="mt-1 block text-sm leading-6 text-muted-foreground">Forwarded, denied, rate limited, or errored with the Prism request identifier.</span>
            </li>
            <li className="py-3">
              <strong className="block text-sm text-foreground">Object, identity, and time</strong>
              <span className="mt-1 block text-sm leading-6 text-muted-foreground">Safe object identifiers, execution mode, and a UTC timestamp.</span>
            </li>
          </ul>
        </div>
      ) : null}
      {activity.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-border bg-background/75" aria-label="Recent Prism activity" data-density="compact">
          {activity.map((entry) => (
            <article key={entry.id} className="border-b border-border/80 px-2.5 py-1.5 last:border-b-0" data-compact-row>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="min-w-0 font-mono text-xs font-semibold leading-4 text-foreground [overflow-wrap:anywhere]">
                  {safeAuditText(entry.slackMethod ?? activityLabel(entry.activityType))}
                </h3>
                {entry.actionCategory ? (
                  <span className="inline-flex rounded-full bg-muted/55 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase leading-3 tracking-[0.12em] text-muted-foreground">
                    {safeAuditText(entry.actionCategory)}
                  </span>
                ) : null}
                <StatusBadge className="h-4 px-1.5 text-[0.625rem] leading-3" tone={activityStatusTone(entry.status)}>
                  {formatStatus(entry.status)}
                </StatusBadge>
                <span className="font-mono text-[0.6875rem] leading-4 text-muted-foreground">
                  <span className="sr-only">When </span>
                  {formatUtcDateTime(entry.occurredAt)}
                </span>
              </div>
              <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                <Metadata label="Profile" value={entry.tokenProfileName ?? entry.tokenProfileId ?? "Session"} />
                <Metadata label="Object" value={objectLabel(entry)} />
                <Metadata label="Identity" value={entry.executionMode} />
                <Metadata label="Request" value={entry.requestId} />
                <Metadata label="HTTP" value={entry.httpStatus === null ? null : String(entry.httpStatus)} />
                <Metadata label="Upstream" value={entry.upstreamCalled ? "Slack called" : "Prism handled"} />
                <Metadata label="Error" value={entry.errorClass} />
                <Metadata label="Admin" value={adminActorLabel(entry)} />
                <Metadata label="Reason" value={entry.adminReason} />
              </dl>
            </article>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function activityLabel(activityType: ActivityAuditSummary["activityType"]): string {
  if (activityType === "token_profile_created") return "Token profile created";
  if (activityType === "token_profiles_listed") return "Token profiles listed";
  if (activityType === "token_profile_revoked") return "Token profile revoked";
  if (activityType === "token_profile_rotated") return "Token profile rotated";
  if (activityType === "token_profile_policy_updated") return "Token profile policy updated";
  if (activityType === "token_profile_deleted") return "Token profile deleted";
  if (activityType === "slack_connection_removed") return "Slack connection removed";
  if (activityType === "admin_token_profile_revoked") return "Admin revoked Token profile";
  if (activityType === "admin_token_profile_deleted") return "Admin deleted Token profile";
  if (activityType === "admin_slack_connection_removed") return "Admin removed Slack connection";
  return "Slack method";
}

function activityStatusTone(status: ActivityAuditSummary["status"]): "success" | "warning" | "neutral" | "info" {
  if (["forwarded", "created", "listed", "revoked", "rotated", "updated", "deleted"].includes(status)) return "success";
  if (["denied", "unsupported", "upstream_error", "auth_failed", "parse_error", "rate_limited", "identity_unavailable"].includes(status)) {
    return "warning";
  }
  return "info";
}

function Metadata({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <dt className="shrink-0 text-[0.625rem] font-semibold uppercase leading-4 tracking-[0.12em] text-muted-foreground">{label}: </dt>
      <dd className="min-w-0 font-mono text-[0.6875rem] leading-4 text-foreground [overflow-wrap:anywhere]">{safeAuditText(value)}</dd>
    </div>
  );
}

function objectLabel(entry: ActivityAuditSummary): string | null {
  if (entry.objectType && entry.objectId) return `${entry.objectType}:${entry.objectId}`;
  return entry.objectType ?? entry.objectId;
}

function adminActorLabel(entry: ActivityAuditSummary): string | null {
  if (entry.adminActorSlackDisplayName && entry.adminActorSlackUserId) return `${entry.adminActorSlackDisplayName} (${entry.adminActorSlackUserId})`;
  return entry.adminActorSlackUserId ?? entry.adminActorPrismUserId;
}

function formatStatus(status: ActivityAuditSummary["status"]): string {
  return status
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function safeAuditText(value: string): string {
  return value
    .replace(/prism_dev_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/xox[a-z]-[A-Za-z0-9-]+/gi, "[redacted]")
    .replace(/(?:access|refresh)[_-]?token|client[_-]?secret|token[_-]?hash|pepper|refresh[_-]?secret|authorization/gi, "[redacted]");
}
