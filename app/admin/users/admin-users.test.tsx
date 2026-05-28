import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminUserDetailView, AdminUserDirectoryView } from "./admin-users";

describe("Admin Prism user directory UI", () => {
  it("renders empty and populated directory states with active scope", () => {
    const empty = renderToStaticMarkup(<AdminUserDirectoryView scope={{ kind: "global" }} users={[]} />);
    expect(empty).toContain("No Prism users in this admin scope");
    expect(empty).toContain("global");

    const populated = renderToStaticMarkup(
      <AdminUserDirectoryView
        scope={{ kind: "team", teamId: "T_ADMIN" }}
        users={[
          {
            prismUserId: "target_user",
            slackUser: { id: "U_TARGET", displayName: "Target User" },
            team: { id: "T_ADMIN", name: "Admin Team" },
            enterprise: { id: "E_ADMIN", name: "Admin Org" },
            slackConnection: { id: "conn_1", status: "healthy", lastErrorClass: null, updatedAt: "2026-02-01T12:00:00.000Z" },
            tokenProfiles: {
              activeCount: 2,
              revokedCount: 1,
              activeDeveloperTokenCount: 1,
              expiredDeveloperTokenCount: 1,
              revokedDeveloperTokenCount: 1
            },
            latestActivityAt: "2026-02-01T12:05:00.000Z"
          }
        ]}
      />
    );

    expect(populated).toContain("Prism user directory");
    expect(populated).toContain("Target User (U_TARGET)");
    expect(populated).toContain('href="/admin/users/target_user"');
    expect(populated).not.toMatch(/prism_dev_|tokenHash|token_hash|xox[bp]-|access_token|refresh_token|refreshToken|client_secret|pepper/i);
  });

  it("renders target user detail with profiles and metadata-only activity safely", () => {
    const html = renderToStaticMarkup(
      <AdminUserDetailView
        scope={{ kind: "global" }}
        detail={{
          user: {
            prismUserId: "target_user",
            slackUser: { id: "U_TARGET", displayName: "Target refreshToken" },
            team: { id: "T_TARGET", name: "Target Team token_hash" },
            enterprise: null,
            slackConnection: { id: "conn_1", status: "reauth_required", lastErrorClass: "tokenHash_error", updatedAt: "2026-02-01T12:00:00.000Z" },
            tokenProfiles: {
              activeCount: 1,
              revokedCount: 1,
              activeDeveloperTokenCount: 1,
              expiredDeveloperTokenCount: 0,
              revokedDeveloperTokenCount: 1
            },
            latestActivityAt: "2026-02-01T12:10:00.000Z"
          },
          profiles: [
            {
              id: "profile_1",
              name: "Profile refresh_token",
              intendedUse: "Read Slack locally",
              preset: "read_only",
              executionIdentity: "automatic",
              expiresAt: null,
              status: "active",
              createdAt: "2026-02-01T12:00:00.000Z",
              developerToken: { status: "active", createdAt: "2026-02-01T12:00:00.000Z", expiresAt: null, lastUsedAt: null, revokedAt: null, overlapExpiresAt: null }
            }
          ],
          activity: [
            {
              id: "activity_1",
              occurredAt: "2026-02-01T12:05:00.000Z",
              activityType: "slack_method",
              status: "forwarded",
              tokenProfileId: "profile_1",
              tokenProfileName: "Profile token_hash",
              slackMethod: "conversations.list",
              actionCategory: "read",
              surface: "channel",
              objectType: "channel",
              objectId: "C123",
              executionMode: "automatic",
              errorClass: null,
              httpStatus: 200,
              upstreamCalled: true,
              requestId: "req_1"
            }
          ]
        }}
      />
    );

    expect(html).toContain("Prism user detail");
    expect(html).toContain("Target [redacted] (U_TARGET)");
    expect(html).toContain("Profile [redacted]");
    expect(html).toContain("Recent Prism activity");
    expect(html).not.toMatch(/tokenHash|token_hash|prism_dev_|xox[bp]-|access_token|refresh_token|refreshToken|client_secret|pepper/i);
  });
});
