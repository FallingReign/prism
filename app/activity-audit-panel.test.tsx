import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityAuditPanel } from "./activity-audit-panel";

describe("Prism website activity audit panel", () => {
  it("labels Token profile lifecycle events without secret material", () => {
    const html = renderToStaticMarkup(
      <ActivityAuditPanel
        activity={[
          {
            id: "audit_1",
            occurredAt: "2026-01-01T00:00:00.000Z",
            activityType: "token_profile_rotated",
            status: "rotated",
            tokenProfileId: "profile_1",
            tokenProfileName: "Local MCP",
            slackMethod: null,
            actionCategory: "15m",
            surface: null,
            objectType: null,
            objectId: null,
            executionMode: null,
            errorClass: null,
            httpStatus: 200,
            upstreamCalled: false,
            requestId: "req_rotate"
          }
        ]}
      />
    );

    expect(html).toContain("Token profile rotated");
    expect(html).toContain("rotated");
    expect(html).toContain("15m");
    expect(html).toContain("2026-01-01 00:00:00 UTC");
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[bp]-|refresh-secret|client_secret|access_token/i);
  });
});
