import { cookies } from "next/headers";

import { database } from "../src/server/db";
import { prismSessionCookieName } from "../src/server/slack/oauth-flow";
import { getSlackLinkStatus } from "../src/server/slack/postgres-store";
import { listTokenProfiles } from "../src/server/token-profiles/service";
import { createPostgresTokenProfileStore } from "../src/server/token-profiles/store";
import { SlackStatusPanel, type SlackWebsiteStatus } from "./slack-status-panel";
import { TokenProfilesPanel, type TokenProfileSummary } from "./token-profiles-panel";

export const dynamic = "force-dynamic";

export default function Home() {
  return <HomeContent />;
}

async function HomeContent() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(prismSessionCookieName)?.value;
  const status = await readSlackWebsiteStatus(sessionToken);
  const tokenProfiles = status.kind === "linked" ? await readTokenProfileSummaries(sessionToken) : [];

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="prism-title">
        <p className="eyebrow">Prism hosted service</p>
        <h1 id="prism-title">A Slack-compatible bridge for developer-owned local tools.</h1>
        <p>
          The Prism website helps developers prepare local tools to call Prism while Slack credentials stay with the Prism hosted service.
        </p>
      </section>
      <section className="cards" aria-label="Prism boundaries">
        <article>
          <h2>Prism hosted service</h2>
          <p>Owns Slack credential custody, policy enforcement, and future Slack-compatible API forwarding.</p>
        </article>
        <article>
          <h2>Prism website</h2>
          <p>Provides the user-facing setup surface for linking Slack and issuing copy-once Prism developer tokens.</p>
        </article>
        <article>
          <h2>Local tools</h2>
          <p>Developer-owned CLIs, MCP servers, coding agents, and apps will call Prism with Prism developer tokens.</p>
        </article>
      </section>
      <SlackStatusPanel status={status} />
      {status.kind === "linked" ? <TokenProfilesPanel slackStatus={status.status} initialProfiles={tokenProfiles} /> : null}
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
    expiresAt: profile.expiresAt?.toISOString() ?? null,
    createdAt: profile.createdAt.toISOString()
  }));
}
