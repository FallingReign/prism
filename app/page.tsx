import { cookies } from "next/headers";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../src/server/admin/allowlist";
import { resolvePrismAdmin } from "../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../src/server/admin/postgres-store";
import { createPostgresActivityAuditStore } from "../src/server/audit/postgres-store";
import { toActivityAuditSummary, type ActivityAuditSummary } from "../src/server/audit/presentation";
import { isSetupRequiredError } from "../src/server/config";
import { database } from "../src/server/db";
import { prismSessionCookieName } from "../src/server/slack/oauth-flow";
import { getSlackLinkStatusWithDisplayNameEnrichment } from "../src/server/slack/connection-status";
import { createConfiguredSlackAppConfigurationResolver } from "../src/server/slack/app-configuration-factory";
import { createPostgresGlobalTokenProfilePolicyStore } from "../src/server/token-profiles/global-policy-store";
import { listTokenProfiles } from "../src/server/token-profiles/service";
import { createPostgresTokenProfileStore } from "../src/server/token-profiles/store";
import { ActivityAuditPanel } from "./activity-audit-panel";
import { SkillInstallCta } from "./skill-install-cta";
import { SlackStatusPanel, type SlackWebsiteStatus } from "./slack-status-panel";
import { tokenProfilePolicyOptionsFromGlobalPolicy, type TokenProfilePolicyOptions } from "./token-profile-policy-options";
import { toTokenProfileSummary, type TokenProfileSummary } from "./token-profile-summary";
import { TokenProfilesPanel } from "./token-profiles-panel";
import { LinkButton, Notice, Panel, StatusBadge } from "./ui";
import { buildWebsiteOverview } from "./website-overview";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const resolvedSearchParams = await searchParams;
  const slackAuthorizationResult = safeSlackAuthorizationResult(resolvedSearchParams?.slack);
  const slackAuthorizationFailure = safeSlackAuthorizationFailure(resolvedSearchParams?.reason);
  const slackAuthorizationSuccess = safeSlackAuthorizationSuccess(resolvedSearchParams, slackAuthorizationResult);
  return await HomeContent(slackAuthorizationResult, slackAuthorizationFailure, slackAuthorizationSuccess);
}

async function HomeContent(
  slackAuthorizationResult: "linked" | "error" | null,
  slackAuthorizationFailure: SlackAuthorizationFailure,
  slackAuthorizationSuccess: SlackAuthorizationSuccess
) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(prismSessionCookieName)?.value;
  const status = await readSlackWebsiteStatus(sessionToken);
  const canUseAdminConsole = await readAdminConsoleVisibility(sessionToken);
  const globalPolicyStore = createPostgresGlobalTokenProfilePolicyStore(database);
  const tokenProfiles = status.kind === "linked" ? await readTokenProfileSummaries(sessionToken, globalPolicyStore) : [];
  const tokenProfilePolicyOptions = status.kind === "linked" ? await readTokenProfilePolicyOptions(globalPolicyStore) : undefined;
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
          <a
            aria-label="API reference (opens reference page)"
            className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            href="/api-reference"
          >
            API reference
          </a>
        </nav>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <StatusBadge tone={overview.slack.tone}>{overview.slack.label}</StatusBadge>
          {canUseAdminConsole ? (
            <LinkButton href="/admin" variant="quiet">
              Admin console
            </LinkButton>
          ) : null}
          {status.kind === "not_linked" || (status.kind === "linked" && status.status === "reauth_required") ? (
            <LinkButton href="/v1/slack/oauth/start" variant="secondary">
              {slackActionLabel}
            </LinkButton>
          ) : null}
        </div>
      </header>

      {slackAuthorizationResult === "error" ? (
        <Notice title="Slack authorization did not complete" tone="warning">
          {slackAuthorizationFailureCopy(slackAuthorizationFailure)} Your existing Slack connection was left unchanged. Prism will
          only replace the active website session after Slack returns and the new connection is stored successfully.
        </Notice>
      ) : null}

      {slackAuthorizationSuccess?.kind === "complete" ? (
        <Notice title="Slack organization connected" tone="success">
          Prism confirmed {slackAuthorizationSuccess.grants} granted {slackAuthorizationSuccess.grants === 1 ? "workspace" : "workspaces"}.
        </Notice>
      ) : null}

      {slackAuthorizationSuccess?.kind === "unavailable" ? (
        <Notice title="Slack organization connected" tone="warning">
          Prism could not load workspace grants yet. Existing grants were preserved. Reload the workspace directory from Playtest or try authorization again.
        </Notice>
      ) : null}

      <section className="rounded-3xl bg-card/85 p-5 shadow-sm ring-1 ring-foreground/5 backdrop-blur lg:p-6" aria-labelledby="prism-title">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)] lg:items-start">
          <div className="min-w-0 max-w-3xl">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Prism hosted service</p>
            <h1 id="prism-title" className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Slack bridge control plane
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Slack OAuth and tokens stay server-side. Local CLIs, MCP servers, and coding agents receive scoped Prism developer
              tokens, policy enforcement, rate limits, and metadata-only audit.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <SkillInstallCta />
              <span className="text-xs leading-5 text-muted-foreground">Give your local agent the hosted install instructions.</span>
            </div>
          </div>
          <SlackStatusPanel status={status} variant="compact" />
        </div>
      </section>

      <section className="grid gap-5" aria-label="Primary setup workspace">
        {status.kind === "linked" ? (
          <TokenProfilesPanel slackStatus={status.status} initialProfiles={tokenProfiles} policyOptions={tokenProfilePolicyOptions} />
        ) : (
          <Panel
            title="Token profiles unlock after Slack is connected"
            titleId="token-profiles-title"
            eyebrow="Token profiles"
            accent="primary"
            actions={status.kind === "not_linked" ? <LinkButton href="/v1/slack/oauth/start">{slackActionLabel}</LinkButton> : undefined}
          >
            <p>
              Create copy-once Prism developer tokens after Slack is linked. Each Token profile captures the intended local tool,
              allowed Slack methods, execution identity, and expiry behavior.
            </p>
          </Panel>
        )}
      </section>
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

function safeSlackAuthorizationResult(value: string | string[] | undefined): "linked" | "error" | null {
  return value === "linked" || value === "error" ? value : null;
}

type SlackAuthorizationSuccess = { kind: "complete"; grants: number } | { kind: "unavailable" } | null;

function safeSlackAuthorizationSuccess(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  result: "linked" | "error" | null
): SlackAuthorizationSuccess {
  if (result !== "linked" || searchParams?.installation !== "organization") return null;
  if (searchParams.grant_sync === "unavailable") return { kind: "unavailable" };
  const grants = searchParams.grants;
  if (typeof grants !== "string" || !/^\d{1,5}$/.test(grants)) return null;
  const parsed = Number(grants);
  return parsed <= 10_000 ? { kind: "complete", grants: parsed } : null;
}

type SlackAuthorizationFailure =
  | "authorization_denied"
  | "runtime_unavailable"
  | "provider_rejected"
  | "invalid_provider_response"
  | "persistence_failed"
  | null;

function safeSlackAuthorizationFailure(value: string | string[] | undefined): SlackAuthorizationFailure {
  return value === "authorization_denied" || value === "runtime_unavailable" || value === "provider_rejected" ||
    value === "invalid_provider_response" || value === "persistence_failed" ? value : null;
}

function slackAuthorizationFailureCopy(reason: SlackAuthorizationFailure): string {
  if (reason === "authorization_denied") return "Slack authorization was cancelled or denied.";
  if (reason === "runtime_unavailable") return "Prism could not load the active Slack configuration.";
  if (reason === "provider_rejected") return "Slack rejected the authorization exchange.";
  if (reason === "invalid_provider_response") return "Slack returned an installation response Prism could not safely validate.";
  if (reason === "persistence_failed") return "Prism could not safely store the new Slack connection.";
  return "The attempted Slack authorization failed before a new connection was stored.";
}

async function readSlackWebsiteStatus(sessionToken: string | undefined): Promise<SlackWebsiteStatus> {
  try {
    const configuration = await createConfiguredSlackAppConfigurationResolver().getStatus();
    if (configuration.kind === "setup_required") return { kind: "setup_required" };
  } catch (error) {
    if (isSetupRequiredError(error)) return { kind: "setup_required" };
    return { kind: "not_linked" };
  }

  try {
    return await getSlackLinkStatusWithDisplayNameEnrichment({ database, sessionToken });
  } catch {
    return { kind: "not_linked" };
  }
}

async function readAdminConsoleVisibility(sessionToken: string | undefined): Promise<boolean> {
  if (!sessionToken) return false;
  try {
    const decision = await resolvePrismAdmin({
      store: createPostgresAdminIdentityStore(database),
      allowlist: loadAdminAllowlist,
      sessionToken
    });
    return decision.kind === "authorized";
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return false;
    return false;
  }
}

async function readTokenProfileSummaries(
  sessionToken: string | undefined,
  globalPolicyStore: ReturnType<typeof createPostgresGlobalTokenProfilePolicyStore>
): Promise<TokenProfileSummary[]> {
  const result = await listTokenProfiles({
    store: createPostgresTokenProfileStore(database),
    globalPolicyStore,
    sessionToken
  });
  if (result.kind !== "profiles") return [];
  return result.profiles.map(toTokenProfileSummary);
}

async function readTokenProfilePolicyOptions(globalPolicyStore: ReturnType<typeof createPostgresGlobalTokenProfilePolicyStore>): Promise<TokenProfilePolicyOptions> {
  return tokenProfilePolicyOptionsFromGlobalPolicy((await globalPolicyStore.readGlobalTokenProfilePolicy()).policy);
}

async function readActivityAudit(sessionToken: string | undefined): Promise<ActivityAuditSummary[]> {
  const activity = await createPostgresActivityAuditStore(database).listRecentActivityForSession({ sessionToken, limit: 20 });
  return activity.map(toActivityAuditSummary);
}
