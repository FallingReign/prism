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
    <main className="site-shell">
      <header className="product-header" aria-label="Prism product navigation">
        <a className="brand-lockup" href="/">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span>
            <strong>Prism</strong>
            <span>Slack bridge</span>
          </span>
        </a>
        <nav className="product-nav" aria-label="Primary">
          <a href="#slack-status-title">Slack status</a>
          <a href="#token-profiles-title">Token profiles</a>
          <a href="#activity-audit-title">Metadata audit</a>
        </nav>
        <div className="header-actions">
          <StatusBadge tone={overview.slack.tone}>{overview.slack.label}</StatusBadge>
          {status.kind !== "linked" || status.status === "reauth_required" ? (
            <LinkButton href="/v1/slack/oauth/start" variant="secondary">
              {slackActionLabel}
            </LinkButton>
          ) : null}
        </div>
      </header>

      <section className="hero-panel" aria-labelledby="prism-title">
        <div className="hero-copy">
          <p className="eyebrow">Prism hosted service</p>
          <h1 id="prism-title">Slack access for local tools, without handing them Slack credentials.</h1>
          <p>
            Prism owns OAuth, policy, forwarding, rate limits, and metadata-only audit. Local CLIs, MCP servers, and coding agents
            receive Prism developer tokens scoped to a Token profile.
          </p>
        </div>
        <div className="hero-card" aria-label="Prism trust boundary">
          <p className="hero-card__label">Trust boundary</p>
          <p className="hero-card__value">Slack tokens stay server-side.</p>
          <p>Use Token profiles to decide what a local tool can read, write, rotate, or revoke.</p>
        </div>
      </section>

      <section className="overview-grid" aria-label="Prism status overview">
        <SummaryMetric {...overview.slack} />
        <SummaryMetric {...overview.custody} />
        <SummaryMetric {...overview.tokenProfiles} />
        <SummaryMetric {...overview.activity} />
      </section>

      <div className="workspace-grid">
        <section className="workspace-primary" aria-label="Primary setup workspace">
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
        <aside className="workspace-secondary" aria-label="Supporting status and audit context">
          <SlackStatusPanel status={status} />
          {status.kind === "linked" ? (
            <ActivityAuditPanel activity={activity} />
          ) : (
            <Panel title="Metadata audit starts after activity" titleId="activity-audit-title" eyebrow="Metadata audit" accent="info">
              <p>
                Prism records metadata only once Token profiles call Slack through the bridge: method, policy outcome, object IDs,
                request IDs, and time.
              </p>
            </Panel>
          )}
        </aside>
      </div>
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
