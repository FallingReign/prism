import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TokenProfilesPanel } from "./token-profiles-panel";

describe("Prism website Token profiles", () => {
  it("guides Token profile creation through purpose, access, runtime, and review steps", () => {
    const html = renderToStaticMarkup(<TokenProfilesPanel slackStatus="healthy" initialProfiles={[]} />);

    expect(html).toContain("1. Name the local tool");
    expect(html).toContain("2. Choose least-privilege access");
    expect(html).toContain("3. Set runtime boundaries");
    expect(html).toContain("4. Review and create");
    expect(html).toContain("Recommended for MCP readers and context tools");
    expect(html).toContain("Only applies when Custom is selected");
    expect(html).toContain("Destructive methods");
    expect(html).toContain("Applies to Full Slack bridge and Custom profiles.");
    expect(html).toContain("Server custody, Prism token only");
    expect(html).toContain("No Token profiles yet. Create one above to give a local tool scoped Slack access.");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });

  it("shows creation warnings and existing profile metadata without developer token material", () => {
    const html = renderToStaticMarkup(
      <TokenProfilesPanel
        slackStatus="healthy"
        initialProfiles={[
          {
            id: "profile_1",
            name: "Local MCP read",
            intendedUse: "Read Slack context locally",
            preset: "read_only",
            executionIdentity: "automatic",
            expiresAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            developerToken: {
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
              expiresAt: null,
              lastUsedAt: "2026-01-01T00:15:00.000Z",
              overlapExpiresAt: "2026-01-01T01:00:00.000Z"
            }
          }
        ]}
      />
    );

    expect(html).toContain("Create Token profile");
    expect(html).toContain("Slack content is untrusted input to Local tools");
    expect(html).toContain("Prism does not execute local actions");
    expect(html).toContain("Copy the Prism developer token when it is shown");
    expect(html).toContain("Local MCP read");
    expect(html).toContain("Read-only");
    expect(html).toContain("Token status");
    expect(html).toContain("Active");
    expect(html).toContain("Last used");
    expect(html).toContain("2026-01-01 00:15:00 UTC");
    expect(html).toContain("Overlap until");
    expect(html).toContain("2026-01-01 01:00:00 UTC");
    expect(html).toContain("Rotate token");
    expect(html).toContain("Revoke token");
    expect(html).toContain("Update policy");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });

  it("explains profile rotation, policy changes, and revocation as deliberate management actions", () => {
    const html = renderToStaticMarkup(
      <TokenProfilesPanel
        slackStatus="healthy"
        initialProfiles={[
          {
            id: "profile_1",
            name: "Release notes agent",
            intendedUse: "Post release notes",
            preset: "messages_only",
            executionIdentity: "user",
            expiresAt: "2026-04-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
            developerToken: { status: "active", lastUsedAt: null }
          }
        ]}
      />
    );

    expect(html).toContain("Rotate safely");
    expect(html).toContain("Overlap window");
    expect(html).toContain("Policy changes");
    expect(html).toContain("Broadening requires token rotation");
    expect(html).toContain("Policy custom capabilities");
    expect(html).toContain('name="policyRead"');
    expect(html).toContain('name="policyDestructive"');
    expect(html).toContain("Revocation is immediate");
    expect(html).toContain("Manage rotation, policy, and revocation");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });
});
