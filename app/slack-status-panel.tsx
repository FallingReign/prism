export type SlackWebsiteStatus =
  | { kind: "not_linked" }
  | { kind: "setup_required" }
  | {
      kind: "linked";
      status: "healthy" | "reauth_required";
      teamId: string | null;
      enterpriseId?: string | null;
      slackUserId: string;
      lastErrorClass: string | null;
    };

export function SlackStatusPanel({ status }: { status: SlackWebsiteStatus }) {
  if (status.kind === "setup_required") {
    return (
      <section className="status-card" aria-labelledby="slack-status-title">
        <p className="eyebrow">Slack link</p>
        <h2 id="slack-status-title">Setup required</h2>
        <p>Slack OAuth or credential encryption configuration is missing. Add server-side settings, then reconnect.</p>
      </section>
    );
  }

  if (status.kind === "not_linked") {
    return (
      <section className="status-card" aria-labelledby="slack-status-title">
        <p className="eyebrow">Slack link</p>
        <h2 id="slack-status-title">Not linked</h2>
        <p>Connect Slack to let the Prism hosted service hold Slack credentials server-side.</p>
        <a className="button" href="/v1/slack/oauth/start">
          Connect Slack
        </a>
      </section>
    );
  }

  if (status.status === "reauth_required") {
    const scope = slackScopeLabel(status);
    return (
      <section className="status-card warning" aria-labelledby="slack-status-title">
        <p className="eyebrow">Slack link</p>
        <h2 id="slack-status-title">Reauth required</h2>
        <p>
          Slack identity <strong>{status.slackUserId}</strong> in {scope.label} <strong>{scope.value}</strong> needs to reconnect.
        </p>
        <a className="button" href="/v1/slack/oauth/start">
          Reconnect Slack
        </a>
      </section>
    );
  }

  const scope = slackScopeLabel(status);
  return (
    <section className="status-card healthy" aria-labelledby="slack-status-title">
      <p className="eyebrow">Slack link</p>
      <h2 id="slack-status-title">Linked and healthy</h2>
      <p>
        Slack identity <strong>{status.slackUserId}</strong> in {scope.label} <strong>{scope.value}</strong> is linked.
      </p>
    </section>
  );
}

function slackScopeLabel(status: Extract<SlackWebsiteStatus, { kind: "linked" }>): { label: "workspace" | "organization"; value: string } {
  if (status.teamId) return { label: "workspace", value: status.teamId };
  return { label: "organization", value: status.enterpriseId ?? "unknown" };
}
