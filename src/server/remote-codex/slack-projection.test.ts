import { describe, expect, it } from "vitest";

import { buildRemoteCodexHomeView, decodeSessionAction } from "./slack-projection";

describe("remote Codex Slack App Home projection", () => {
  it("shows a private safe catalog with a clear attach action", () => {
    const view = buildRemoteCodexHomeView({
      sessions: [
        {
          installationId: "rc_install_1",
          threadId: "thread_1",
          title: "Ship the companion",
          projectLabel: "remote-codex",
          status: "ready",
          lastActivity: "2026-08-31T08:00:00.000Z",
          machineLabel: "Workstation"
        }
      ]
    });
    const json = JSON.stringify(view);

    expect(view.type).toBe("home");
    expect(json).toContain("Your Codex sessions");
    expect(json).toContain("Ship the companion");
    expect(json).toContain("remote-codex");
    expect(json).toContain("Attach to Slack");
    expect(json).toContain("remote_codex_share_session");
    expect(json).not.toMatch(/c:\\|cwd|preview|prompt|transcript|access.token|refresh.token/i);

    const button = view.blocks.find((block) => block.accessory)?.accessory;
    expect(decodeSessionAction(button?.value ?? "")).toEqual({ installationId: "rc_install_1", threadId: "thread_1" });
  });

  it("gives an install-and-connect action when no computer catalog is available", () => {
    const json = JSON.stringify(buildRemoteCodexHomeView({ sessions: [], connectUrl: "https://prism.example.test/remote-codex" }));
    expect(json).toContain("Connect your computer");
    expect(json).toContain("https://prism.example.test/remote-codex");
  });
});
