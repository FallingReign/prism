import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { createPostgresActivityAuditStore } from "../../../src/server/audit/postgres-store";
import { toActivityAuditSummary } from "../../../src/server/audit/presentation";
import { database } from "../../../src/server/db";
import { prismSessionCookieName } from "../../../src/server/slack/oauth-flow";
import { listTokenProfiles } from "../../../src/server/token-profiles/service";
import { createPostgresTokenProfileStore } from "../../../src/server/token-profiles/store";
import { TokenProfileDetailWorkspace } from "../../token-profile-detail-panel";
import { toTokenProfileSummary } from "../../token-profile-summary";
import { LinkButton, Panel, StatusBadge } from "../../ui";

export const dynamic = "force-dynamic";

type TokenProfileDetailPageProps = {
  params: Promise<{ profileId: string }> | { profileId: string };
};

export default async function TokenProfileDetailPage({ params }: TokenProfileDetailPageProps) {
  const { profileId } = await params;
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(prismSessionCookieName)?.value;
  const profilesResult = await listTokenProfiles({
    store: createPostgresTokenProfileStore(database),
    sessionToken
  });

  if (profilesResult.kind !== "profiles") {
    return (
      <main className="mx-auto grid w-full max-w-4xl gap-5 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
        <Panel
          title="Connect Slack to inspect Token profiles"
          titleId="token-profile-detail-title"
          eyebrow="Token profile"
          accent="primary"
          actions={<LinkButton href="/v1/slack/oauth/start">Connect Slack</LinkButton>}
        >
          <p>Prism needs a linked Slack workspace before it can show Token profile policy, lifecycle, or metadata audit.</p>
        </Panel>
      </main>
    );
  }

  const profile = profilesResult.profiles.find((candidate) => candidate.id === decodeURIComponent(profileId));
  if (!profile) notFound();

  const activity = await createPostgresActivityAuditStore(database).listRecentActivityForTokenProfile({
    sessionToken,
    profileId: profile.id,
    limit: 20
  });

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-5 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card/75 p-3 shadow-sm ring-1 ring-foreground/5 backdrop-blur" aria-label="Token profile navigation">
        <h1 className="sr-only">Token profile: {profile.name}</h1>
        <a className="inline-flex items-center gap-3 rounded-xl text-foreground no-underline" href="/">
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm" aria-hidden="true">
            P
          </span>
          <span className="grid">
            <strong className="text-sm font-semibold leading-5">Prism</strong>
            <span className="text-xs text-muted-foreground">Token profile detail</span>
          </span>
        </a>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={profilesResult.slackStatus === "healthy" ? "success" : "warning"}>
            {profilesResult.slackStatus === "healthy" ? "Slack connected" : "Slack reauth required"}
          </StatusBadge>
          <LinkButton href="/" variant="secondary">
            Back to Token profiles
          </LinkButton>
        </div>
      </header>

      <TokenProfileDetailWorkspace
        initialProfile={toTokenProfileSummary(profile)}
        slackStatus={profilesResult.slackStatus}
        activity={activity.map(toActivityAuditSummary)}
      />
    </main>
  );
}
