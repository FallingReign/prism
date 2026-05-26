import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TokenProfileDetailWorkspace } from "./token-profile-detail-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() })
}));

describe("Token profile detail workspace", () => {
  it("orders lifecycle, policy, then profile-specific Metadata audit without exposing token material", () => {
    const html = renderToStaticMarkup(
      <TokenProfileDetailWorkspace
        slackStatus="healthy"
        profile={{
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
            overlapExpiresAt: null
          }
        }}
        activity={[
          {
            id: "audit_1",
            occurredAt: "2026-01-01T00:15:00.000Z",
            activityType: "slack_method",
            status: "forwarded",
            tokenProfileId: "profile_1",
            tokenProfileName: "Local MCP read",
            slackMethod: "conversations.list",
            actionCategory: "conversations.read",
            surface: "public_channel",
            objectType: "channel",
            objectId: "C123",
            executionMode: "bot",
            errorClass: null,
            httpStatus: 200,
            upstreamCalled: true,
            requestId: "req_1"
          }
        ]}
      />
    );

    expect(html).toContain("Local MCP read");
    expect(html).toContain("Ready");
    expect(html).toContain("Rotate developer token");
    expect(html).toContain("Update policy");
    expect(html).toContain("Profile events");
    expect(html.indexOf("Lifecycle")).toBeGreaterThan(-1);
    expect(html.indexOf("Policy")).toBeGreaterThan(html.indexOf("Lifecycle"));
    expect(html.indexOf("Profile events")).toBeGreaterThan(html.indexOf("Policy"));
    expect(html).toContain("conversations.list");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });

  it("locks lifecycle and policy editing for inactive profiles while offering permanent delete", () => {
    const html = renderToStaticMarkup(
      <TokenProfileDetailWorkspace
        slackStatus="healthy"
        profile={{
          id: "profile_1",
          name: "Release notes agent",
          intendedUse: "Post release notes",
          preset: "messages_only",
          executionIdentity: "user",
          expiresAt: null,
          status: "revoked",
          createdAt: "2026-01-01T00:00:00.000Z",
          developerToken: {
            status: "revoked",
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: null,
            lastUsedAt: null,
            revokedAt: "2026-01-02T00:00:00.000Z",
            overlapExpiresAt: null
          }
        }}
        activity={[]}
      />
    );

    expect(html).toContain("Release notes agent");
    expect(html).toContain("Removed");
    expect(html).toContain("Delete permanently");
    expect(html).toContain("Policy locked");
    expect(html).not.toContain("Rotate developer token");
    expect(html).not.toContain("Update policy");
    expect(html).not.toContain("Remove access");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });
});
