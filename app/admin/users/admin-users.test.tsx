import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminSlackConnectionActionForm } from "./admin-slack-connection-actions";
import { AdminTokenProfileActionForm } from "./admin-token-profile-actions";
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
              capabilities: { read: true },
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
    expect(html).toContain("Prism-local Slack connection removal");
    expect(html).toContain("Remove Slack connection");
    expect(html).toContain("does not revoke Slack authorization");
    expect(html).toContain("Revoke access");
    expect(html).toContain("Admin actions require typed confirmation and a required reason");
    expect(html).toContain("Recent Prism activity");
    expect(html).not.toMatch(/tokenHash|token_hash|prism_dev_|xox[bp]-|access_token|refresh_token|refreshToken|client_secret|pepper/i);
  });

  it("renders disconnected retained users without an admin removal trigger", () => {
    const html = renderToStaticMarkup(
      <AdminUserDetailView
        scope={{ kind: "team", teamId: "T_TARGET" }}
        detail={{
          user: {
            prismUserId: "target_user",
            slackUser: { id: "U_TARGET", displayName: null },
            team: { id: "T_TARGET", name: null },
            enterprise: null,
            slackConnection: { id: null, status: "not_linked", lastErrorClass: null, updatedAt: null },
            tokenProfiles: {
              activeCount: 0,
              revokedCount: 0,
              activeDeveloperTokenCount: 0,
              expiredDeveloperTokenCount: 0,
              revokedDeveloperTokenCount: 0
            },
            latestActivityAt: "2026-02-02T12:05:00.000Z"
          },
          profiles: [],
          activity: [
            {
              id: "activity_admin_remove",
              occurredAt: "2026-02-02T12:05:00.000Z",
              activityType: "admin_slack_connection_removed",
              status: "deleted",
              tokenProfileId: null,
              tokenProfileName: null,
              slackMethod: null,
              actionCategory: null,
              surface: null,
              objectType: "slack_connection",
              objectId: "conn_1",
              executionMode: null,
              errorClass: null,
              httpStatus: 200,
              upstreamCalled: false,
              requestId: "req_admin_remove",
              adminActorPrismUserId: "admin_user",
              adminActorSlackUserId: "U_ADMIN",
              adminActorSlackDisplayName: "Ada Admin",
              adminReason: "Security offboarding"
            }
          ]
        }}
      />
    );

    expect(html).toContain("Disconnected");
    expect(html).toContain("No current Slack connection is linked");
    expect(html).toContain("Admin removed Slack connection");
    expect(html).not.toContain("Prism-local Slack connection removal");
    expect(html).not.toContain("Remove Slack connection");
    expect(html).not.toMatch(/prism_dev_|xox[bp]-|access_token|refresh_token|refreshToken|client_secret|token_hash|pepper/i);
  });

  it("renders admin action dialog controls with typed confirmation and required reason gating", () => {
    const blocked = renderToStaticMarkup(
      <AdminTokenProfileActionForm action="revoke" expectedConfirmation="REVOKE" reason="" confirmation="REVOKE" cancelControl={<button type="button">Cancel</button>} />
    );
    const ready = renderToStaticMarkup(
      <AdminTokenProfileActionForm action="delete" expectedConfirmation="DELETE" reason="Retired local tool" confirmation="DELETE" cancelControl={<button type="button">Cancel</button>} />
    );

    expect(blocked).toContain("Required admin audit reason");
    expect(blocked).toContain("Reason");
    expect(blocked).toContain("required=\"\"");
    expect(blocked).toContain("maxLength=\"240\"");
    expect(blocked).toContain("Type REVOKE to continue");
    expect(blocked).toContain("disabled=\"\"");
    expect(ready).toContain("Type DELETE to continue");
    expect(ready).toContain("Delete Token profile");
    expect(ready).not.toContain("disabled=\"\"");
    expect(`${blocked}${ready}`).not.toMatch(/prism_dev_|xox[bp]-|access_token|refresh_token|refreshToken|client_secret|token_hash|pepper/i);
  });

  it("renders admin Slack connection removal controls with typed REMOVE and required reason gating", () => {
    const blocked = renderToStaticMarkup(<AdminSlackConnectionActionForm reason="" confirmation="REMOVE" cancelControl={<button type="button">Cancel</button>} />);
    const ready = renderToStaticMarkup(<AdminSlackConnectionActionForm reason="Security offboarding" confirmation="REMOVE" cancelControl={<button type="button">Cancel</button>} />);

    expect(blocked).toContain("Required admin audit reason");
    expect(blocked).toContain("Type REMOVE to continue");
    expect(blocked).toContain("required=\"\"");
    expect(blocked).toContain("maxLength=\"240\"");
    expect(blocked).toContain("disabled=\"\"");
    expect(ready).toContain("Remove Slack connection");
    expect(ready).not.toContain("disabled=\"\"");
    expect(`${blocked}${ready}`).not.toMatch(/prism_dev_|xox[bp]-|access_token|refresh_token|refreshToken|client_secret|token_hash|pepper/i);
  });
});
