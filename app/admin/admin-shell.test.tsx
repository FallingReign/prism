import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminAccessDenied, AdminConsoleShell } from "./admin-shell";

describe("Prism admin console shell", () => {
  it("shows the active global, enterprise, and team admin scopes without secret material", () => {
    for (const scope of [
      { kind: "global" as const },
      { kind: "enterprise" as const, enterpriseId: "E_DEV_ORG" },
      { kind: "team" as const, teamId: "T_DEV_TEAM" }
    ]) {
      const html = renderToStaticMarkup(
        <AdminConsoleShell
          decision={{
            kind: "authorized",
            prismUserId: "prism_user_secret_internal",
            slackUserId: "U_ADMIN",
            slackUserDisplayName: "Ada Admin",
            teamId: "T_DEV_TEAM",
            teamName: "Dev Workspace",
            enterpriseId: "E_DEV_ORG",
            enterpriseName: "Dev Org",
            installationScope: "organization",
            workspaceGrants: [
              { teamId: "T_DEV_A", teamName: "2136A Dev" },
              { teamId: "T_DEV_B", teamName: "2136B Dev" }
            ],
            scope
          }}
        />
      );

      expect(html).toContain("Prism admin console");
      expect(html).toContain("Active scope");
      expect(html).toContain("User directory");
      expect(html).toContain("Global policy");
      if (scope.kind === "global") {
        expect(html).toContain("Slack configuration");
        expect(html).toContain('href="/admin/configuration"');
      } else {
        expect(html).not.toContain('href="/admin/configuration"');
      }
      expect(html).toContain("Audited admin actions");
      expect(html).toContain("Prism admin scope");
      expect(html).toContain("Slack installation");
      expect(html).toContain("Organization level");
      expect(html).toContain("2 granted workspaces");
      expect(html).toContain("2136A Dev");
      expect(html).toContain("T_DEV_A");
      expect(html).toContain("global Prism administrator cannot access additional Slack");
      expect(html).not.toContain("Admin surfaces unlock in the next slices");
      expect(html).not.toContain("Destructive admin actions remain separate");
      expect(html).toContain(scope.kind);
      expect(html).toContain('href="/"');
      expect(html).not.toMatch(/prism_user_secret_internal|prism_dev_|tokenHash|xox[bp]-|access_token|refresh_token|client_secret|allowlist/i);
    }
  });

  it("renders a generic denied state without allowlist hints", () => {
    const html = renderToStaticMarkup(<AdminAccessDenied />);

    expect(html).toContain("Admin access unavailable");
    expect(html).toContain("Return to Prism");
    expect(html).not.toMatch(/allowlist|U_ADMIN|config|json|path|prism_dev_|xox[bp]-|client_secret/i);
  });
});
