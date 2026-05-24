import type { ActivityAuditSummary } from "../src/server/audit/presentation";
import { formatUtcDateTime } from "./date-format";

export function ActivityAuditPanel({ activity }: { activity: ActivityAuditSummary[] }) {
  return (
    <section className="status-card activity-audit" aria-labelledby="activity-audit-title">
      <p className="eyebrow">Activity audit</p>
      <h2 id="activity-audit-title">Recent Prism activity</h2>
      <p className="notice">
        This view stores metadata only: methods, policy outcomes, object identifiers, request IDs, and timestamps. Slack message text, search queries,
        file contents, and tokens are not stored.
      </p>
      {activity.length === 0 ? <p>No recent Prism activity yet.</p> : null}
      {activity.length > 0 ? (
        <div className="activity-list" aria-label="Recent Prism activity">
          {activity.map((entry) => (
            <article key={entry.id}>
              <div className="activity-row">
                <h3>{entry.slackMethod ?? activityLabel(entry.activityType)}</h3>
                <span className={`activity-status ${entry.status}`}>{entry.status.replaceAll("_", " ")}</span>
              </div>
              <dl>
                <div>
                  <dt>Profile</dt>
                  <dd>{entry.tokenProfileName ?? entry.tokenProfileId ?? "Session"}</dd>
                </div>
                <div>
                  <dt>When</dt>
                  <dd>{formatUtcDateTime(entry.occurredAt)}</dd>
                </div>
                {entry.actionCategory ? (
                  <div>
                    <dt>Category</dt>
                    <dd>{entry.actionCategory}</dd>
                  </div>
                ) : null}
                {entry.objectType && entry.objectId ? (
                  <div>
                    <dt>Object</dt>
                    <dd>
                      {entry.objectType}:{entry.objectId}
                    </dd>
                  </div>
                ) : null}
                {entry.executionMode ? (
                  <div>
                    <dt>Identity</dt>
                    <dd>{entry.executionMode}</dd>
                  </div>
                ) : null}
                {entry.errorClass ? (
                  <div>
                    <dt>Error</dt>
                    <dd>{entry.errorClass}</dd>
                  </div>
                ) : null}
              </dl>
            </article>
          ))}
        </div>
      ) : null}
    </section>
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
