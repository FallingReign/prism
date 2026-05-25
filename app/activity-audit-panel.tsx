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
      <Notice title="Metadata only" tone="info">
        This view stores metadata only: methods, policy outcomes, object identifiers, request IDs, and timestamps. Slack message text, search queries,
        file contents, and tokens are not stored.
      </Notice>
      {activity.length === 0 ? (
        <div className="activity-empty">
          <h3>No forwarded or blocked calls yet</h3>
          <p>When a Token profile uses the Slack bridge, this workspace will list the metadata you can inspect safely.</p>
          <ul>
            <li>
              <strong>Method and category</strong>
              <span>Slack Web API method plus the policy category Prism evaluated.</span>
            </li>
            <li>
              <strong>Outcome and request ID</strong>
              <span>Forwarded, denied, rate limited, or errored with the Prism request identifier.</span>
            </li>
            <li>
              <strong>Object, identity, and time</strong>
              <span>Safe object identifiers, execution mode, and a UTC timestamp.</span>
            </li>
          </ul>
        </div>
      ) : null}
      {activity.length > 0 ? (
        <div className="activity-list" aria-label="Recent Prism activity">
          {activity.map((entry) => (
            <article key={entry.id} className="activity-card">
              <div className="activity-row">
                <div className="activity-row__title">
                  <h3>{safeAuditText(entry.slackMethod ?? activityLabel(entry.activityType))}</h3>
                  {entry.actionCategory ? <span>{safeAuditText(entry.actionCategory)}</span> : null}
                </div>
                <StatusBadge tone={activityStatusTone(entry.status)}>{formatStatus(entry.status)}</StatusBadge>
              </div>
              <dl className="activity-metadata">
                <Metadata label="Profile" value={entry.tokenProfileName ?? entry.tokenProfileId ?? "Session"} />
                <Metadata label="When" value={formatUtcDateTime(entry.occurredAt)} />
                <Metadata label="Category" value={entry.actionCategory} />
                <Metadata label="Object" value={objectLabel(entry)} />
                <Metadata label="Identity" value={entry.executionMode} />
                <Metadata label="Request" value={entry.requestId} />
                <Metadata label="HTTP" value={entry.httpStatus === null ? null : String(entry.httpStatus)} />
                <Metadata label="Upstream" value={entry.upstreamCalled ? "Slack called" : "Prism handled"} />
                <Metadata label="Error" value={entry.errorClass} />
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
  return "Slack method";
}

function activityStatusTone(status: ActivityAuditSummary["status"]): "success" | "warning" | "neutral" | "info" {
  if (["forwarded", "created", "listed", "revoked", "rotated", "updated"].includes(status)) return "success";
  if (["denied", "unsupported", "upstream_error", "auth_failed", "parse_error", "rate_limited", "identity_unavailable"].includes(status)) {
    return "warning";
  }
  return "info";
}

function Metadata({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{safeAuditText(value)}</dd>
    </div>
  );
}

function objectLabel(entry: ActivityAuditSummary): string | null {
  if (entry.objectType && entry.objectId) return `${entry.objectType}:${entry.objectId}`;
  return entry.objectType ?? entry.objectId;
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
    .replace(/access[_-]?token|client[_-]?secret|tokenHash|pepper|refresh[_-]?secret|authorization/gi, "[redacted]");
}
