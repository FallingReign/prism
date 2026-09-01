import { describe, expect, it } from "vitest";

import { renderLocalAppConsentPage, renderLocalAppResultPage } from "./presentation";

describe("local app authorization presentation", () => {
  it("escapes untrusted app and Slack display values", () => {
    const html = renderLocalAppConsentPage({
      requestId: "00000000-0000-4000-8000-000000000000",
      userCode: "ABCD-2345",
      clientId: "example-app",
      displayName: "<script>bad()</script>",
      intendedUse: "message <img src=x onerror=bad()>",
      expiresAt: new Date("2026-09-01T00:10:00Z"),
      rePairing: true,
      identity: {
        prismUserId: "user-1",
        slackConnectionId: "connection-1",
        slackUserId: "U123",
        slackUserDisplayName: "<b>Person</b>",
        installationScope: "workspace",
        teamId: "T123",
        teamName: "<svg onload=bad()>",
        enterpriseId: null,
        enterpriseName: null
      }
    });
    expect(html).not.toContain("<script>bad()");
    expect(html).not.toContain("<svg onload=bad()>");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).toContain("replaces its current token immediately");
    expect(html).toContain("approving replaces that token immediately");
    expect(html).toContain('name="decision" value="approve"');
  });

  it("offers an in-flow Slack reconnect action", () => {
    const html = renderLocalAppResultPage("connection_unavailable", {
      reconnectUrl: "https://prism.example/v1/slack/oauth/start?local_app_request=00000000-0000-4000-8000-000000000000"
    });
    expect(html).toContain("Reconnect Slack");
    expect(html).toContain("local_app_request=00000000-0000-4000-8000-000000000000");
  });
});
