import { LinkButton, Notice, Panel, StatusBadge } from "./ui";
import { slackScopeDisplay, slackUserDisplay } from "./slack-connection-display";
import { SlackConnectionActions } from "./slack-connection-actions";

export type SlackWebsiteStatus =
  | { kind: "not_linked" }
  | { kind: "setup_required" }
  | {
      kind: "linked";
      status: "healthy" | "reauth_required";
      teamId: string | null;
      teamName?: string | null;
      enterpriseId?: string | null;
      enterpriseName?: string | null;
      slackUserId: string;
      slackUserDisplayName?: string | null;
      lastErrorClass: string | null;
    };

export function SlackStatusPanel({ status, variant = "panel" }: { status: SlackWebsiteStatus; variant?: "panel" | "compact" }) {
  if (variant === "compact") {
    return <CompactSlackStatus status={status} />;
  }

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

  function CompactSlackStatus({ status }: { status: SlackWebsiteStatus }) {
    if (status.kind === "setup_required") {
      return (
        <section className="rounded-2xl border border-[color:var(--prism-warning)]/55 bg-[color:var(--prism-warning-soft)]/55 p-4" aria-labelledby="slack-status-title">
          <CompactHeading title="Setup required" tone="warning" badge="Configuration needed" />
          <p className="mt-3 text-sm leading-6 text-muted-foreground">Add Slack OAuth and encryption settings before connecting this hosted service.</p>
        </section>
      );
    }

    if (status.kind === "not_linked") {
      return (
        <section className="rounded-2xl border border-primary/35 bg-primary/5 p-4" aria-labelledby="slack-status-title">
          <CompactHeading title="Connect Slack" tone="primary" badge="Not connected" />
          <p className="mt-3 text-sm leading-6 text-muted-foreground">Connect Slack before creating Token profiles for local tools.</p>
          <LinkButton href="/v1/slack/oauth/start" className="mt-4" variant="secondary">
            Connect Slack
          </LinkButton>
        </section>
      );
    }

    const scope = slackScopeDisplay(status);

    if (status.status === "reauth_required") {
      return (
        <section className="rounded-2xl border border-[color:var(--prism-warning)]/55 bg-[color:var(--prism-warning-soft)]/55 p-4" aria-labelledby="slack-status-title">
          <CompactHeading title="Reconnect Slack" tone="warning" badge="Reconnect needed" />
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {scope.label} <strong className="break-words text-foreground">{scope.value}</strong> is connected for Slack user{" "}
            <strong className="break-words text-foreground">{slackUserDisplay(status)}</strong>. Reconnect before Slack calls resume.
          </p>
          <SlackConnectionActions reauthRequired compact />
        </section>
      );
    }

    return (
      <section className="rounded-2xl border border-[color:var(--prism-success)]/45 bg-[color:var(--prism-success-soft)]/55 p-4" aria-labelledby="slack-status-title">
        <CompactHeading title="Slack connected" tone="success" badge="Connected" />
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {scope.label} <strong className="break-words text-foreground">{scope.value}</strong> is connected for Slack user{" "}
          <strong className="break-words text-foreground">{slackUserDisplay(status)}</strong>.
        </p>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">Credentials are encrypted on the server. Local tools use Prism developer tokens.</p>
        <SlackConnectionActions compact />
      </section>
    );
  }

  function CompactHeading({ title, badge, tone }: { title: string; badge: string; tone: "success" | "warning" | "primary" }) {
    return (
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Slack connection</p>
          <h2 id="slack-status-title" className="text-xl font-semibold tracking-tight text-foreground">
            {title}
          </h2>
        </div>
        <StatusBadge tone={tone}>{badge}</StatusBadge>
      </div>
    );
  }

  if (status.status === "reauth_required") {
    const scope = slackScopeDisplay(status);
    return (
      <Panel
        title="Reconnect Slack"
        titleId="slack-status-title"
        eyebrow="Slack connection"
        accent="warning"
        badge={<StatusBadge tone="warning">Reconnect needed</StatusBadge>}
        actions={<SlackConnectionActions reauthRequired />}
      >
        <p>
          {scope.label} <strong className="break-words">{scope.value}</strong> is connected for Slack user <strong className="break-words">{slackUserDisplay(status)}</strong>,
          but Slack calls need a fresh authorization.
        </p>
      </Panel>
    );
  }

  const scope = slackScopeDisplay(status);
  return (
    <Panel
      title="Slack connected"
      titleId="slack-status-title"
      eyebrow="Slack connection"
      accent="success"
      badge={<StatusBadge tone="success">Connected</StatusBadge>}
      actions={<SlackConnectionActions />}
    >
      <p>
        {scope.label} <strong className="break-words">{scope.value}</strong> is connected for Slack user <strong className="break-words">{slackUserDisplay(status)}</strong>.
      </p>
      <Notice title="Custody boundary" tone="success">
        Credentials are encrypted on the server. Local tools use Prism developer tokens.
      </Notice>
    </Panel>
  );
}
