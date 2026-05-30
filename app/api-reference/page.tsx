import { apiEndpointGroups, authModelLabel, type ApiEndpoint } from "./endpoint-catalog";
import { LinkButton, Notice, Panel, StatusBadge } from "../ui";

export const metadata = {
  title: "Prism API reference"
};

export default function ApiReferencePage() {
  return (
    <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
      <a className="sr-only rounded-full bg-background px-4 py-2 text-sm font-semibold text-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:ring-2 focus:ring-ring" href="#api-reference-title">
        Skip to content
      </a>
      <header
        className="grid gap-4 rounded-2xl bg-card/75 p-3 shadow-sm ring-1 ring-foreground/5 backdrop-blur sm:grid-cols-[auto_1fr_auto] sm:items-center"
      >
        <a className="inline-flex items-center gap-3 rounded-xl text-foreground no-underline" href="/">
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm" aria-hidden="true">
            P
          </span>
          <span className="grid">
            <strong className="text-sm font-semibold leading-5">Prism</strong>
            <span className="text-xs text-muted-foreground">API reference</span>
          </span>
        </a>
        <nav className="flex flex-wrap gap-1 sm:justify-center" aria-label="API reference sections">
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="#local-tool-endpoints">
            Local tools
          </a>
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="#website-session-management-endpoints">
            Website session
          </a>
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="#admin-handoff">
            Admin handoff
          </a>
        </nav>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <LinkButton href="/" variant="secondary">
            Back to workspace
          </LinkButton>
        </div>
      </header>

      <section className="rounded-3xl bg-card/85 p-5 shadow-sm ring-1 ring-foreground/5 backdrop-blur lg:p-6" aria-labelledby="api-reference-title">
        <div className="max-w-3xl">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Prism hosted service</p>
          <h1 id="api-reference-title" className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Prism API reference
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
            Use <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">PRISM_BASE_URL</code> as the base URL.
            Local tools authenticate with <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">Authorization: Bearer prism_dev_...</code>.
            Website management endpoints use the Prism website session cookie created by Slack OAuth.
          </p>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.38fr)]" aria-label="Reference guidance">
        <Panel title="Headers and diagnostics" titleId="diagnostics-title" eyebrow="Runtime signals" accent="info">
          <p>
            Slack-compatible forwarding can include <code>X-Prism-Surface</code>, <code>X-Prism-Workspace-ID</code>,{" "}
            <code>X-Prism-Execution-Mode</code>, <code>X-Prism-Request-ID</code>, and <code>X-Prism-Upstream-Called</code>.
            Prism-side rate limit and upstream Slack rate limit responses preserve <code>Retry-After</code> when available; compare with{" "}
            <a className="font-medium text-primary underline-offset-4 hover:underline" href="https://docs.slack.dev/apis/web-api/rate-limits/">
              Slack rate limit documentation
            </a>
            .
          </p>
          <p>Common local-tool failures include policy denied, unsupported method, reauth required, and rate-limited responses.</p>
        </Panel>
        <Panel title="Custody and audit posture" titleId="custody-title" eyebrow="Safety" accent="primary">
          <p>
            Slack credentials stay in Prism credential custody. Prism activity is metadata only: method, policy outcome, object IDs,
            request IDs, timing, and rate-limit metadata without Slack payload content.
          </p>
          <p>Events, slash commands, Block Kit interactivity, file transfer, canvases, and lists are deferred v1 surfaces.</p>
        </Panel>
      </section>

      <section className="grid gap-5" aria-label="Endpoint groups">
        {apiEndpointGroups.map((group) => (
          <Panel key={group.title} title={group.title} titleId={sectionId(group.title)} eyebrow="Endpoint group" accent={group.endpoints.length > 0 ? "neutral" : "warning"}>
            <p>{group.description}</p>
            {group.endpoints.length > 0 ? (
              <div className="grid gap-3">
                {group.endpoints.map((endpoint) => (
                  <EndpointCard endpoint={endpoint} key={`${endpoint.method} ${endpoint.path}`} />
                ))}
              </div>
            ) : (
              <Notice title="Admin console owns admin operations" tone="warning">
                <p>
                  Admin operations live in the Prism admin console and require existing Prism admin authorization. This page keeps
                  detailed admin-only API routes out of the developer reference.
                </p>
              </Notice>
            )}
          </Panel>
        ))}
      </section>
    </main>
  );
}

function EndpointCard({ endpoint }: { endpoint: ApiEndpoint }) {
  const headingId = `endpoint-${endpoint.method}-${endpoint.path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  return (
    <article aria-labelledby={headingId} className="grid gap-3 rounded-xl border border-border bg-background/65 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <StatusBadge tone={endpoint.method === "GET" ? "info" : endpoint.method === "POST" ? "primary" : "danger"}>{endpoint.method}</StatusBadge>
        <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs text-foreground sm:text-sm">{endpoint.path}</code>
        <StatusBadge tone={endpoint.authModel === "prismDeveloperToken" ? "primary" : endpoint.authModel === "websiteSession" ? "info" : "neutral"}>
          {authModelLabel(endpoint.authModel)}
        </StatusBadge>
      </div>
      <div>
        <h3 id={headingId} className="font-semibold text-foreground">
          {endpoint.summary}
        </h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {endpoint.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      </div>
      {endpoint.example ? (
        <pre className="overflow-x-auto rounded-xl bg-muted/70 p-3 text-xs leading-5 text-foreground">
          <code>{endpoint.example}</code>
        </pre>
      ) : null}
      {endpoint.docsLinks?.length ? (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {endpoint.docsLinks.map((link) => (
            <a className="font-medium text-primary underline-offset-4 hover:underline" href={link.href} key={link.href}>
              {link.label}
            </a>
          ))}
        </p>
      ) : null}
    </article>
  );
}

function sectionId(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
