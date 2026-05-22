import { cookies } from "next/headers";

import { database } from "../src/server/db";
import { prismSessionCookieName } from "../src/server/slack/oauth-flow";
import { getSlackLinkStatus } from "../src/server/slack/postgres-store";
import { SlackStatusPanel, type SlackWebsiteStatus } from "./slack-status-panel";

export const dynamic = "force-dynamic";

export default function Home() {
  return <HomeContent />;
}

async function HomeContent() {
  const cookieStore = await cookies();
  const status = await readSlackWebsiteStatus(cookieStore.get(prismSessionCookieName)?.value);

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
          <p>Provides the user-facing setup surface for linking Slack and managing token profiles in later slices.</p>
        </article>
        <article>
          <h2>Local tools</h2>
          <p>Developer-owned CLIs, MCP servers, coding agents, and apps will call Prism with Prism developer tokens.</p>
        </article>
      </section>
      <SlackStatusPanel status={status} />
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
