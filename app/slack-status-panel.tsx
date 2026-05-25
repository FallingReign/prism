import { LinkButton, Notice, Panel, StatusBadge } from "./ui";

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
      <Panel
        title="Setup required"
        titleId="slack-status-title"
        eyebrow="Slack link"
        accent="warning"
        badge={<StatusBadge tone="warning">Configuration needed</StatusBadge>}
      >
        <p>Slack OAuth or credential encryption configuration is missing. Add server-side settings, then reconnect.</p>
      </Panel>
    );
  }

  if (status.kind === "not_linked") {
    return (
      <Panel
        title="Not linked"
        titleId="slack-status-title"
        eyebrow="Slack link"
        accent="primary"
        badge={<StatusBadge>Waiting for OAuth</StatusBadge>}
        actions={<LinkButton href="/v1/slack/oauth/start">Connect Slack</LinkButton>}
      >
        <p>Connect Slack to let the Prism hosted service hold Slack credentials server-side.</p>
        <Notice title="Custody boundary" tone="info">
          Local tools only receive Prism developer tokens after Slack is connected.
        </Notice>
      </Panel>
    );
  }

  if (status.status === "reauth_required") {
    const scope = slackScopeLabel(status);
    return (
      <Panel
        title="Reauth required"
        titleId="slack-status-title"
        eyebrow="Slack link"
        accent="warning"
        badge={<StatusBadge tone="warning">Reconnect needed</StatusBadge>}
        actions={<LinkButton href="/v1/slack/oauth/start">Reconnect Slack</LinkButton>}
      >
        <p>
          Slack identity <strong>{status.slackUserId}</strong> in {scope.label} <strong>{scope.value}</strong> needs to reconnect.
        </p>
      </Panel>
    );
  }

  const scope = slackScopeLabel(status);
  return (
    <Panel
      title="Linked and healthy"
      titleId="slack-status-title"
      eyebrow="Slack link"
      accent="success"
      badge={<StatusBadge tone="success">Ready for forwarding</StatusBadge>}
    >
      <p>
        Slack identity <strong>{status.slackUserId}</strong> in {scope.label} <strong>{scope.value}</strong> is linked.
      </p>
      <Notice title="Server custody active" tone="success">
        Slack credentials remain encrypted and server-held while local tools use Prism developer tokens.
      </Notice>
    </Panel>
  );
}

function slackScopeLabel(status: Extract<SlackWebsiteStatus, { kind: "linked" }>): { label: "workspace" | "organization"; value: string } {
  if (status.teamId) return { label: "workspace", value: status.teamId };
  return { label: "organization", value: status.enterpriseId ?? "unknown" };
}
