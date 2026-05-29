import { describe, expect, it } from "vitest";

import { buildWebsiteOverview } from "./website-overview";
import type { TokenProfileSummary } from "./token-profile-summary";

const profile = (status: NonNullable<TokenProfileSummary["developerToken"]>["status"]): TokenProfileSummary => ({
  id: `profile_${status}`,
  name: `Profile ${status}`,
  intendedUse: "Local tool access",
  preset: "read_only",
  executionIdentity: "user",
  capabilities: { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false },
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  developerToken: { status }
});

describe("Prism website overview", () => {
  it("explains the not-linked state without secret material", () => {
    const overview = buildWebsiteOverview({ kind: "not_linked" }, [], []);

    expect(overview.slack.label).toBe("Slack not linked");
    expect(overview.tokenProfiles.value).toBe("0 active");
    expect(overview.activity.value).toBe("No activity");
    expect(`${overview.slack.detail} ${overview.custody.detail}`).not.toMatch(/xox[bp]-|refresh-secret|client_secret|access_token|prism_dev_/i);
  });

  it("counts active Token profiles and recent Metadata-only activity for linked sessions", () => {
    const overview = buildWebsiteOverview(
      {
        kind: "linked",
        status: "healthy",
        teamId: "T123",
        teamName: "Example Workspace",
        slackUserId: "U123",
        slackUserDisplayName: "Ada Lovelace",
        lastErrorClass: null
      },
      [profile("active"), profile("revoked"), profile("expired"), profile("missing")],
      [
        {
          id: "audit_1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          activityType: "slack_method",
          status: "forwarded",
          tokenProfileId: "profile_active",
          tokenProfileName: "Local MCP",
          slackMethod: "chat.postMessage",
          actionCategory: "messages.write",
          surface: "public_channel",
          objectType: "channel",
          objectId: "C123",
          executionMode: "user",
          errorClass: null,
          httpStatus: 200,
          upstreamCalled: true,
          requestId: "req_1"
        }
      ]
    );

    expect(overview.slack.label).toBe("Slack connected");
    expect(overview.slack.detail).toContain("Ada Lovelace");
    expect(overview.slack.detail).toContain("U123");
    expect(overview.slack.detail).toContain("Example Workspace");
    expect(overview.slack.detail).toContain("T123");
    expect(overview.tokenProfiles.value).toBe("1 active");
    expect(overview.tokenProfiles.detail).toBe("4 total Token profiles");
    expect(overview.activity.value).toBe("1 recent event");
    expect(overview.custody.value).toBe("Server-held Slack credentials");
  });
});
