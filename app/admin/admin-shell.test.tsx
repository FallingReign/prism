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
            scope
          }}
        />
      );

      expect(html).toContain("Prism admin console");
      expect(html).toContain("Active scope");
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
