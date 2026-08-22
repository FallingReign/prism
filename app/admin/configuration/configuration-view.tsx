import { LinkButton, Notice, Panel, StatusBadge, SummaryMetric } from "../../ui";

export type AdminConfigurationSummary = {
  source: "database" | "environment";
  version?: string;
  secretConfigured: true;
  botScopes: string[];
  userScopes: string[];
  activatedAt: string | null;
  activatedBy: string | null;
};

export function AdminConfigurationView({ configuration, callbackUri }: { configuration: AdminConfigurationSummary; callbackUri: string }) {
  const environment = configuration.source === "environment";
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
      <header className="grid gap-4 rounded-2xl bg-card/75 p-3 shadow-sm ring-1 ring-foreground/5 backdrop-blur sm:grid-cols-[auto_1fr_auto] sm:items-center">
        <a className="inline-flex items-center gap-3 rounded-xl text-foreground no-underline" href="/admin">
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground" aria-hidden="true">P</span>
          <span className="grid"><strong className="text-sm font-semibold">Prism admin</strong><span className="text-xs text-muted-foreground">Slack configuration</span></span>
        </a>
        <nav className="flex flex-wrap gap-1 sm:justify-center" aria-label="Configuration admin">
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="/admin">Admin overview</a>
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-foreground" href="/admin/configuration" aria-current="page">Slack configuration</a>
        </nav>
        <StatusBadge tone={environment ? "info" : "success"}>{environment ? "Environment locked" : "Active"}</StatusBadge>
      </header>

      <Panel title={environment ? "Environment locked" : "Prism configuration"} titleId="configuration-title" eyebrow="Slack app" accent={environment ? "info" : "success"}>
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryMetric label="Source" value={environment ? "Environment" : "Prism database"} detail={environment ? "The host owns this complete configuration bundle." : "Prism stores an encrypted, verified configuration version."} tone="primary" />
          <SummaryMetric label="Version" value={environment ? "Deployment managed" : `Version ${configuration.version ?? "unknown"}`} detail="OAuth remains bound to one immutable configuration revision." tone="info" />
          <SummaryMetric label="Client secret" value="Stored securely" detail="The secret value is never returned to this page." tone="success" />
        </div>
        {environment ? <Notice title="Read-only configuration" tone="info">Environment-managed Slack credentials cannot be replaced or revealed from the browser.</Notice> : null}
        <section className="grid gap-2 rounded-xl bg-muted/35 p-4">
          <h3 className="text-sm font-semibold text-foreground">Slack redirect URL</h3>
          <code className="overflow-x-auto rounded-lg bg-background px-3 py-2 text-xs text-foreground">{callbackUri}</code>
        </section>
        <div className="grid gap-3 sm:grid-cols-2">
          <ScopeList title="User scopes" values={configuration.userScopes} />
          <ScopeList title="Bot scopes" values={configuration.botScopes} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <SummaryMetric label="Last activated" value={configuration.activatedAt ? new Date(configuration.activatedAt).toLocaleString("en-AU", { timeZone: "UTC" }) : environment ? "Deployment managed" : "Recorded at activation"} detail={configuration.activatedAt ? "Shown in UTC." : "See the metadata audit for the activation event."} tone="neutral" />
          <SummaryMetric label="Activated by" value={configuration.activatedBy ?? (environment ? "Deployment host" : "Configuration administrator")} detail="Prism records identity metadata, never credential material." tone="neutral" />
        </div>
        <LinkButton href="/admin" variant="secondary">Return to admin console</LinkButton>
      </Panel>
    </main>
  );
}

function ScopeList({ title, values }: { title: string; values: string[] }) {
  return (
    <section className="rounded-xl border border-border bg-background/65 p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {values.length ? <ul className="mt-3 flex flex-wrap gap-2">{values.map((scope) => <li key={scope}><StatusBadge>{scope}</StatusBadge></li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">None</p>}
    </section>
  );
}
