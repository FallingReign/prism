import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Remote Codex Slack manifest", () => {
  it("enables only the narrow signed App Home surface and keeps Socket Mode off", () => {
    const manifest = readFileSync(resolve(process.cwd(), "docs/slack/prism-slack-app-manifest.template.yml"), "utf8");
    expect(manifest).toContain("home_tab_enabled: true");
    expect(manifest).toContain("app_home_opened");
    expect(manifest).toContain("/v1/slack/events");
    expect(manifest).toContain("/v1/slack/interactivity");
    expect(manifest).toMatch(/bot:\s[\s\S]*?- im:write/);
    expect(manifest).toContain("socket_mode_enabled: false");
    expect(manifest).not.toMatch(/slash_commands:|message\.(channels|groups|im|mpim)/);
  });
});
