import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { database } from "@/src/server/db";
import { getPairingApprovalContext, type PairingApprovalContext } from "@/src/server/remote-codex/browser-pairing";
import { prismSessionCookieName } from "@/src/server/slack/oauth-flow";
import { Button, LinkButton, Notice, Panel, StatusBadge } from "../../../ui";

export const dynamic = "force-dynamic";

export default async function PairingApprovalPage({
  params,
  searchParams
}: {
  params: Promise<{ pairingId: string }>;
  searchParams: Promise<{ connected?: string }>;
}) {
  const [{ pairingId }, query] = await Promise.all([params, searchParams]);
  if (query.connected === "1") return <PairingConnectedView />;

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(prismSessionCookieName)?.value;
  const context = await getPairingApprovalContext(database, { pairingId, sessionToken });
  return <PairingApprovalView pairingId={pairingId} context={context} />;
}

export function PairingApprovalView({
  pairingId,
  context
}: {
  pairingId: string;
  context: PairingApprovalContext;
}) {
  if (context.kind === "unauthenticated") {
    return (
      <PairingShell>
        <Panel title="Connect Slack first" eyebrow="Prism Companion" accent="primary">
          <p>Prism uses your own Slack identity to make sure nobody else can control Codex sessions on this computer.</p>
          <p>Connect Slack, then return to Prism Companion and choose <strong>Connect to Prism</strong> again.</p>
          <div>
            <LinkButton href={`/v1/slack/oauth/start?remote_codex_pairing=${encodeURIComponent(pairingId)}`}>Connect Slack</LinkButton>
          </div>
        </Panel>
      </PairingShell>
    );
  }

  if (context.kind !== "ready") {
    return (
      <PairingShell>
        <Panel title="This connection is no longer available" eyebrow="Prism Companion" accent="warning">
          <p>The request may have expired or already been used. Return to Prism Companion and choose <strong>Connect to Prism</strong> again.</p>
        </Panel>
      </PairingShell>
    );
  }

  return (
    <PairingShell>
      <Panel
        title={`Connect ${context.machineLabel}?`}
        eyebrow="Prism Companion"
        accent="primary"
        badge={<StatusBadge tone="info">One-time setup</StatusBadge>}
      >
        <p>
          This lets the Prism tray app on this computer show your existing Codex sessions in Slack. It does not send a session to Slack until you choose one.
        </p>
        <Notice title="Check the words match" tone="info">
          Prism Companion should show <strong className="font-mono text-foreground">{context.verificationPhrase}</strong>. If it does not, close this page.
        </Notice>
        <form
          className="grid gap-4"
          method="post"
          action={`/v1/prism/remote-codex/pairings/${encodeURIComponent(pairingId)}/approve`}
        >
          <div className="rounded-xl border border-border bg-muted/35 p-3 text-foreground">
            <strong>{context.identity.slackUserLabel}</strong>
            <div className="text-xs text-muted-foreground">
              {context.identity.installationLabel} · {context.identity.slackUserId}
            </div>
          </div>
          {context.workspaces.length === 1 ? (
            <input type="hidden" name="teamId" value={context.workspaces[0]!.teamId} />
          ) : (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-semibold text-foreground">Share from this workspace</legend>
              {context.workspaces.map((workspace, index) => (
              <label key={workspace.teamId} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-muted/35 p-3 text-foreground">
                <input
                  className="mt-1 size-4 accent-primary"
                  type="radio"
                  name="teamId"
                  value={workspace.teamId}
                  defaultChecked={index === 0}
                  required
                />
                <span className="grid"><strong>{workspace.label}</strong><span className="text-xs text-muted-foreground">{workspace.teamId}</span></span>
              </label>
              ))}
            </fieldset>
          )}
          <Button type="submit">Connect this computer</Button>
        </form>
        <p className="text-xs">Only this Slack identity can attach sessions from this computer. Slack commands and approvals are not enabled.</p>
      </Panel>
    </PairingShell>
  );
}

function PairingConnectedView() {
  return (
    <PairingShell>
      <Panel title="Computer connected" eyebrow="Prism Companion" accent="success" badge={<StatusBadge tone="success">Ready</StatusBadge>}>
        <p>Prism Companion is finishing setup. You can close this tab and choose a Codex session from the tray app.</p>
      </Panel>
    </PairingShell>
  );
}

function PairingShell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-2xl place-content-center gap-5 px-4 py-10 sm:px-6">
      <header className="flex items-center justify-center gap-3" aria-label="Prism">
        <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm" aria-hidden="true">
          P
        </span>
        <strong className="text-lg">Prism</strong>
      </header>
      {children}
    </main>
  );
}
