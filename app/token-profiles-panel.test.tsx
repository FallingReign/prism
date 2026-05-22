import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TokenProfilesPanel } from "./token-profiles-panel";

describe("Prism website Token profiles", () => {
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
    expect(html).toContain("Overlap until");
    expect(html).toContain("Rotate token");
    expect(html).toContain("Revoke token");
    expect(html).toContain("Update policy");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });
});
