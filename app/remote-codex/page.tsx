import { getRemoteCodexInstallerUrl } from "@/src/server/config";
import { LinkButton, Notice, Panel, StatusBadge } from "../ui";

export const dynamic = "force-dynamic";

export default function RemoteCodexSetupPage() {
  return <RemoteCodexSetupView installerUrl={getRemoteCodexInstallerUrl()} />;
}

export function RemoteCodexSetupView({ installerUrl }: { installerUrl: string | null }) {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-3xl place-content-center gap-5 px-4 py-10 sm:px-6">
      <header className="flex items-center justify-center gap-3" aria-label="Prism">
        <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm" aria-hidden="true">P</span>
        <strong className="text-lg">Prism</strong>
      </header>
      <Panel
        title="Use your Codex sessions in Slack"
        eyebrow="Prism Companion"
        accent="primary"
        badge={<StatusBadge tone="info">Windows pilot</StatusBadge>}
      >
        <p>Install the small tray companion once. It starts with Windows and finds your existing Codex sessions automatically.</p>
        <ol className="grid gap-3 text-sm">
          <li><strong>1. Install.</strong> Open the setup file and launch Prism Companion.</li>
          <li><strong>2. Connect.</strong> Choose <em>Connect to Prism</em> in the tray app and approve the matching words in your browser.</li>
          <li><strong>3. Share.</strong> Choose a session on your computer or open Prism App Home in Slack.</li>
        </ol>
        {installerUrl ? (
          <div><LinkButton href={installerUrl}>Download Prism Companion</LinkButton></div>
        ) : (
          <Notice title="Installer not published yet" tone="warning">
            Your Prism administrator still needs to publish the approved Windows pilot installer.
          </Notice>
        )}
        <p className="text-xs">This first pilot mirrors safe session status only. Slack messages are not sent to Codex.</p>
      </Panel>
    </main>
  );
}
