import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PairingApprovalView } from "./page";

describe("remote Codex pairing approval page", () => {
  it("shows the matching phrase and exact Slack identity in a plain-language one-click approval", () => {
    const html = renderToStaticMarkup(
      <PairingApprovalView
        pairingId="rc_pair_1"
        context={{
          kind: "ready",
          pairingId: "rc_pair_1",
          machineLabel: "Jill's Workstation",
          companionVersion: "0.1.0",
          verificationPhrase: "violet-river-42",
          expiresAt: "2026-08-31T06:10:00.000Z",
          identity: {
              connectionId: "connection-owner",
              installationLabel: "Example Workspace",
              slackUserId: "U123",
              slackUserLabel: "Jill"
          },
          workspaces: [{ teamId: "T123", label: "Example Workspace" }]
        }}
      />
    );

    expect(html).toContain("Jill&#x27;s Workstation");
    expect(html).toContain("violet-river-42");
    expect(html).toContain("Example Workspace");
    expect(html).toContain("Jill");
    expect(html).toContain("Connect this computer");
    expect(html).toContain("T123");
    expect(html).not.toContain("connection-owner");
    expect(html).not.toMatch(/public.key|private.key|one.time.secret|access.token|refresh.token/i);
  });

  it("returns an unauthenticated user to the same pairing after Slack authorization", () => {
    const html = renderToStaticMarkup(
      <PairingApprovalView pairingId="rc_pair_abcdefgh12345678" context={{ kind: "unauthenticated" }} />
    );

    expect(html).toContain("remote_codex_pairing=rc_pair_abcdefgh12345678");
    expect(html).not.toMatch(/return_to|returnTo/i);
  });
});
