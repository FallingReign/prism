import type { AdminAuthorizationDecision, AdminScope } from "../../src/server/admin/authorization";
import { LinkButton, Panel, StatusBadge, SummaryMetric } from "../ui";

type AuthorizedAdminDecision = Extract<AdminAuthorizationDecision, { kind: "authorized" }>;

export function AdminConsoleShell({ decision }: { decision: AuthorizedAdminDecision }) {
  const scope = scopeSummary(decision.scope, decision);
  const actorLabel = decision.slackUserDisplayName ? `${decision.slackUserDisplayName} (${decision.slackUserId})` : decision.slackUserId;

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
      <header className="grid gap-4 rounded-2xl bg-card/75 p-3 shadow-sm ring-1 ring-foreground/5 backdrop-blur sm:grid-cols-[auto_1fr_auto] sm:items-center">
        <a className="inline-flex items-center gap-3 rounded-xl text-foreground no-underline" href="/admin">
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm" aria-hidden="true">
            P
          </span>
          <span className="grid">
            <strong className="text-sm font-semibold leading-5">Prism admin</strong>
            <span className="text-xs text-muted-foreground">Scoped console</span>
          </span>
        </a>
        <nav className="flex flex-wrap gap-1 sm:justify-center" aria-label="Admin">
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="#admin-scope-title">
            Active scope
          </a>
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="/admin/users">
            User directory
          </a>
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="/admin/token-profile-policy">
            Global policy
          </a>
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="/">
            User workspace
          </a>
        </nav>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <StatusBadge tone="success">{scope.badge}</StatusBadge>
          <LinkButton href="/" variant="secondary">
            Return to Prism
          </LinkButton>
        </div>
      </header>

      <section className="rounded-3xl bg-card/85 p-5 shadow-sm ring-1 ring-foreground/5 backdrop-blur lg:p-6" aria-labelledby="admin-title">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Prism-only administration</p>
        <h1 id="admin-title" className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Prism admin console
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
          Review your server-resolved admin scope, inspect Prism users, govern Global Token profile policy, and perform audited
          local Prism access actions without administering Slack.
        </p>
      </section>

      <Panel title="Active scope" titleId="admin-scope-title" eyebrow="Authorization" accent="primary" badge={<StatusBadge tone="success">{scope.badge}</StatusBadge>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryMetric label="Scope" value={scope.value} detail={scope.detail} tone="primary" />
          <SummaryMetric label="Prism admin" value={actorLabel} detail="Resolved from the current Slack-authenticated website session." tone="neutral" />
          <SummaryMetric label="Workspace" value={decision.teamName ?? decision.teamId ?? "No workspace"} detail="Current Slack connection used for scoped authorization." tone="info" />
        </div>
      </Panel>

      <Panel title="Audited admin actions" titleId="admin-actions-title" eyebrow="Admin console" accent="info">
        <p>
          Use the scoped Prism user directory, Global Token profile policy, and typed-confirmation admin actions to manage Prism-owned
          local access while preserving metadata-only audit.
        </p>
        <LinkButton href="/admin/users" variant="secondary">
          Open user directory
        </LinkButton>
        <LinkButton href="/admin/token-profile-policy" variant="secondary">
          Open global policy
        </LinkButton>
      </Panel>
    </main>
  );
}

export function AdminUserNotFound() {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-3xl place-items-center px-4 py-10 sm:px-6">
      <Panel
        title="Prism user not found"
        titleId="admin-user-not-found-title"
        eyebrow="Prism admin"
        accent="warning"
        actions={
          <LinkButton href="/admin/users" variant="secondary">
            Return to user directory
          </LinkButton>
        }
      >
        <p>The requested Prism user does not exist or is outside your admin scope.</p>
      </Panel>
    </main>
  );
}

export function AdminAccessDenied() {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-3xl place-items-center px-4 py-10 sm:px-6">
      <Panel
        title="Admin access unavailable"
        titleId="admin-denied-title"
        eyebrow="Prism admin"
        accent="warning"
        actions={
          <LinkButton href="/" variant="secondary">
            Return to Prism
          </LinkButton>
        }
      >
        <p>This page only opens when Prism can confirm an active admin scope for your current Slack-authenticated website session.</p>
      </Panel>
    </main>
  );
}

function scopeSummary(scope: AdminScope, decision: AuthorizedAdminDecision): { badge: string; value: string; detail: string } {
  if (scope.kind === "global") {
    return { badge: "global", value: "global", detail: "Can administer Prism across the deployment." };
  }
  if (scope.kind === "enterprise") {
    return {
      badge: "enterprise",
      value: decision.enterpriseName ? `${decision.enterpriseName} (${scope.enterpriseId})` : scope.enterpriseId,
      detail: "Can administer Prism users in this Slack organization scope."
    };
  }
  return {
    badge: "team",
    value: decision.teamName ? `${decision.teamName} (${scope.teamId})` : scope.teamId,
    detail: "Can administer Prism users in this Slack workspace scope."
  };
}
