import { describe, expect, it } from "vitest";

import { resolvePrismAdmin, type AdminIdentityStore } from "./authorization";

describe("Prism admin authorization", () => {
  it("authorizes a global Prism admin from the website session Slack identity", async () => {
    const now = new Date("2026-02-01T12:00:00.000Z");
    const store: AdminIdentityStore = {
      async getCurrentIdentity(input) {
        expect(input).toEqual({ sessionToken: "session-token", now });
        return {
          prismUserId: "prism_user_1",
          slackUserId: "U_ADMIN_GLOBAL",
          slackUserDisplayName: "Ada Admin",
          teamId: "T_DEV",
          teamName: "Dev Workspace",
          enterpriseId: "E_ORG",
          enterpriseName: "Dev Org"
        };
      }
    };

    const decision = await resolvePrismAdmin({
      store,
      allowlist: {
        entries: [{ slackUserId: "U_ADMIN_GLOBAL", scope: { kind: "global" } }]
      },
      sessionToken: "session-token",
      now
    });

    expect(decision).toEqual({
      kind: "authorized",
      prismUserId: "prism_user_1",
      slackUserId: "U_ADMIN_GLOBAL",
      slackUserDisplayName: "Ada Admin",
      teamId: "T_DEV",
      teamName: "Dev Workspace",
      enterpriseId: "E_ORG",
      enterpriseName: "Dev Org",
      scope: { kind: "global" }
    });
  });

  it("distinguishes enterprise and team scoped Prism admins", async () => {
      const store = identityStore({
        prismUserId: "prism_user_1",
        slackUserId: "U_SCOPED",
        slackUserDisplayName: null,
        teamId: "T_DEV",
        teamName: "Dev Workspace",
        enterpriseId: "E_ORG",
        enterpriseName: "Dev Org"
      });

      await expect(
        resolvePrismAdmin({
          store,
          allowlist: { entries: [{ slackUserId: "U_SCOPED", scope: { kind: "enterprise", enterpriseId: "E_ORG" } }] },
          sessionToken: "session-token",
          now: new Date("2026-02-01T12:00:00.000Z")
        })
      ).resolves.toMatchObject({ kind: "authorized", scope: { kind: "enterprise", enterpriseId: "E_ORG" } });

      await expect(
        resolvePrismAdmin({
          store,
          allowlist: { entries: [{ slackUserId: "U_SCOPED", scope: { kind: "team", teamId: "T_DEV" } }] },
          sessionToken: "session-token",
          now: new Date("2026-02-01T12:00:00.000Z")
        })
      ).resolves.toMatchObject({ kind: "authorized", scope: { kind: "team", teamId: "T_DEV" } });
  });

  it("denies missing, expired, non-admin, and scope-mismatched sessions without authorizing a scope", async () => {
      const identity = {
        prismUserId: "prism_user_1",
        slackUserId: "U_USER",
        slackUserDisplayName: null,
        teamId: "T_DEV",
        teamName: "Dev Workspace",
        enterpriseId: "E_ORG",
        enterpriseName: "Dev Org"
      };

      await expect(
        resolvePrismAdmin({
          store: identityStore(identity),
          allowlist: { entries: [{ slackUserId: "U_USER", scope: { kind: "global" } }] },
          sessionToken: undefined
        })
      ).resolves.toEqual({ kind: "unauthenticated" });

      await expect(
        resolvePrismAdmin({
          store: identityStore(null),
          allowlist: { entries: [{ slackUserId: "U_USER", scope: { kind: "global" } }] },
          sessionToken: "expired-session"
        })
      ).resolves.toEqual({ kind: "unauthenticated" });

      await expect(
        resolvePrismAdmin({
          store: identityStore(identity),
          allowlist: { entries: [{ slackUserId: "U_OTHER", scope: { kind: "global" } }] },
          sessionToken: "session-token"
        })
      ).resolves.toEqual({ kind: "not_admin", reason: "no_matching_entry" });

      await expect(
        resolvePrismAdmin({
          store: identityStore(identity),
          allowlist: { entries: [{ slackUserId: "U_USER", scope: { kind: "team", teamId: "T_OTHER" } }] },
          sessionToken: "session-token"
        })
      ).resolves.toEqual({ kind: "not_admin", reason: "scope_mismatch" });
  });

  it("uses the broadest effective scope when multiple allowlist entries match", async () => {
      await expect(
        resolvePrismAdmin({
          store: identityStore({
            prismUserId: "prism_user_1",
            slackUserId: "U_MULTI",
            slackUserDisplayName: null,
            teamId: "T_DEV",
            teamName: "Dev Workspace",
            enterpriseId: "E_ORG",
            enterpriseName: "Dev Org"
          }),
          allowlist: {
            entries: [
              { slackUserId: "U_MULTI", scope: { kind: "team", teamId: "T_DEV" } },
              { slackUserId: "U_MULTI", scope: { kind: "global" } },
              { slackUserId: "U_MULTI", scope: { kind: "enterprise", enterpriseId: "E_ORG" } }
            ]
          },
          sessionToken: "session-token"
        })
      ).resolves.toMatchObject({ kind: "authorized", scope: { kind: "global" } });
  });
});

function identityStore(identity: Awaited<ReturnType<AdminIdentityStore["getCurrentIdentity"]>>): AdminIdentityStore {
  return {
    async getCurrentIdentity() {
      return identity;
    }
  };
}
