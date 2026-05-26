import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TokenProfilesPanel } from "./token-profiles-panel";

describe("Prism website Token profiles", () => {
  it("renders a clean active Token profile workspace instead of an inline dashboard", () => {
    const html = renderToStaticMarkup(<TokenProfilesPanel slackStatus="healthy" initialProfiles={[]} />);

    expect(html).toContain("Token profiles");
    expect(html).toContain("Create Token profile");
    expect(html).toContain("No Token profiles yet.");
    expect(html).toContain("Add the local tools that should call Slack through Prism.");
    expect(html).not.toContain("1. Name the local tool");
    expect(html).not.toContain("2. Choose least-privilege access");
    expect(html).not.toContain("Manage rotation, policy, and revocation");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });

  it("shows only active-list summary fields and click-through for existing profiles", () => {
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

    expect(html).toContain("Local MCP read");
    expect(html).toContain("Ready");
    expect(html).toContain("/token-profiles/profile_1");
    expect(html).toContain("Remove access");
    expect(html).not.toContain("Read-only");
    expect(html).not.toContain("Last used");
    expect(html).not.toContain("Rotate token");
    expect(html).not.toContain("Update policy");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });

  it("preserves inactive Token profiles and offers permanent deletion", () => {
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
            status: "revoked",
            createdAt: "2026-01-01T00:00:00.000Z",
            developerToken: { status: "revoked", lastUsedAt: null }
          }
        ]}
      />
    );

    expect(html).toContain("Release notes agent");
    expect(html).toContain("Removed");
    expect(html).toContain("Delete permanently");
    expect(html).not.toContain("No Token profiles yet.");
    expect(html).not.toContain("Remove access");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });

  it("marks reauth as unavailable access without hiding configured profiles", () => {
    const html = renderToStaticMarkup(
      <TokenProfilesPanel
        slackStatus="reauth_required"
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

    expect(html).toContain("Release notes agent");
    expect(html).toContain("Needs Slack reauth");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });
});
