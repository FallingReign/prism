import { cookies } from "next/headers";

import { createPostgresActivityAuditStore } from "../src/server/audit/postgres-store";
import { toActivityAuditSummary, type ActivityAuditSummary } from "../src/server/audit/presentation";
import { database } from "../src/server/db";
import { prismSessionCookieName } from "../src/server/slack/oauth-flow";
import { getSlackLinkStatus } from "../src/server/slack/postgres-store";
import { listTokenProfiles } from "../src/server/token-profiles/service";
import { createPostgresTokenProfileStore } from "../src/server/token-profiles/store";
import { ActivityAuditPanel } from "./activity-audit-panel";
import { SlackStatusPanel, type SlackWebsiteStatus } from "./slack-status-panel";
import { TokenProfilesPanel, type TokenProfileSummary } from "./token-profiles-panel";
import { LinkButton, Panel, StatusBadge, SummaryMetric } from "./ui";
import { buildWebsiteOverview } from "./website-overview";

export const dynamic = "force-dynamic";

export default function Home() {
  return <HomeContent />;
}

async function HomeContent() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(prismSessionCookieName)?.value;
  const status = await readSlackWebsiteStatus(sessionToken);
  const tokenProfiles = status.kind === "linked" ? await readTokenProfileSummaries(sessionToken) : [];
  const activity = status.kind === "linked" ? await readActivityAudit(sessionToken) : [];
  const overview = buildWebsiteOverview(status, tokenProfiles, activity);
  const slackActionLabel = status.kind === "linked" && status.status === "reauth_required" ? "Reconnect Slack" : "Connect Slack";

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
      <header className="grid gap-4 rounded-2xl bg-card/75 p-3 shadow-sm ring-1 ring-foreground/5 backdrop-blur sm:grid-cols-[auto_1fr_auto] sm:items-center" aria-label="Prism product navigation">
        <a className="inline-flex items-center gap-3 rounded-xl text-foreground no-underline" href="/">
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm" aria-hidden="true">
            P
          </span>
          <span className="grid">
            <strong className="text-sm font-semibold leading-5">Prism</strong>
            <span className="text-xs text-muted-foreground">Slack bridge</span>
          </span>
        </a>
        <nav className="flex flex-wrap gap-1 sm:justify-center" aria-label="Primary">
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="#slack-status-title">
            Slack status
          </a>
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="#token-profiles-title">
            Token profiles
          </a>
          <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="#activity-audit-title">
            Metadata audit
          </a>
        </nav>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <StatusBadge tone={overview.slack.tone}>{overview.slack.label}</StatusBadge>
          {status.kind !== "linked" || status.status === "reauth_required" ? (
            <LinkButton href="/v1/slack/oauth/start" variant="secondary">
              {slackActionLabel}
            </LinkButton>
          ) : null}
        </div>
      </header>

      <section className="rounded-3xl bg-card/85 p-5 shadow-sm ring-1 ring-foreground/5 backdrop-blur lg:p-6" aria-labelledby="prism-title">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="max-w-3xl">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Prism hosted service</p>
            <h1 id="prism-title" className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Slack bridge control plane
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Slack OAuth and tokens stay server-side. Local CLIs, MCP servers, and coding agents receive scoped Prism developer
              tokens, policy enforcement, rate limits, and metadata-only audit.
            </p>
          </div>
          <div className="rounded-2xl bg-muted/45 p-4 text-sm leading-6 text-muted-foreground" aria-label="Prism trust boundary">
            <p className="font-semibold text-foreground">Credential custody stays with Prism.</p>
            <p>Profiles decide which Slack methods a local tool can call, and audit stores metadata only.</p>
          </div>
        </div>
        <div className="mt-5 hidden gap-3 xl:grid xl:grid-cols-4" aria-label="Prism status overview">
          <SummaryMetric {...overview.slack} />
          <SummaryMetric {...overview.custody} />
          <SummaryMetric {...overview.tokenProfiles} />
          <SummaryMetric {...overview.activity} />
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)] xl:items-start">
        <section className="order-2 grid gap-5 xl:order-1" aria-label="Primary setup workspace">
          {status.kind === "linked" ? (
            <TokenProfilesPanel slackStatus={status.status} initialProfiles={tokenProfiles} />
          ) : (
            <Panel
              title="Token profiles unlock after Slack is connected"
              titleId="token-profiles-title"
              eyebrow="Token profiles"
              accent="primary"
              actions={<LinkButton href="/v1/slack/oauth/start">{slackActionLabel}</LinkButton>}
            >
              <p>
                Create copy-once Prism developer tokens after Slack is linked. Each Token profile captures the intended local tool,
                allowed Slack methods, execution identity, and expiry behavior.
              </p>
            </Panel>
          )}
        </section>
        <aside className="order-1 grid gap-5 xl:order-2" aria-label="Supporting status context">
          <SlackStatusPanel status={status} />
        </aside>
      </div>
      {status.kind === "linked" ? (
        <ActivityAuditPanel activity={activity} />
      ) : (
        <Panel title="Metadata audit starts after activity" titleId="activity-audit-title" eyebrow="Metadata audit" accent="info">
          <p>
            Prism records metadata only once Token profiles call Slack through the bridge: method, policy outcome, object IDs, request
            IDs, and time.
          </p>
        </Panel>
      )}
    </main>
  );
}

async function readSlackWebsiteStatus(sessionToken: string | undefined): Promise<SlackWebsiteStatus> {
  try {
    return await getSlackLinkStatus(database, sessionToken);
  } catch {
    return { kind: "not_linked" };
  }
}

async function readTokenProfileSummaries(sessionToken: string | undefined): Promise<TokenProfileSummary[]> {
  const result = await listTokenProfiles({
    store: createPostgresTokenProfileStore(database),
    sessionToken
  });
  if (result.kind !== "profiles") return [];
  return result.profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    intendedUse: profile.intendedUse,
    preset: profile.preset,
    executionIdentity: profile.capabilityMap.executionIdentity,
    expiresAt: profile.expiresAt?.toISOString() ?? null,
    createdAt: profile.createdAt.toISOString(),
    developerToken: profile.developerToken
      ? {
          status: profile.developerToken.status,
          createdAt: profile.developerToken.createdAt?.toISOString() ?? null,
          expiresAt: profile.developerToken.expiresAt?.toISOString() ?? null,
          lastUsedAt: profile.developerToken.lastUsedAt?.toISOString() ?? null,
          revokedAt: profile.developerToken.revokedAt?.toISOString() ?? null,
          overlapExpiresAt: profile.developerToken.overlapExpiresAt?.toISOString() ?? null
        }
      : undefined
  }));
}

async function readActivityAudit(sessionToken: string | undefined): Promise<ActivityAuditSummary[]> {
  const activity = await createPostgresActivityAuditStore(database).listRecentActivityForSession({ sessionToken, limit: 20 });
  return activity.map(toActivityAuditSummary);
}
