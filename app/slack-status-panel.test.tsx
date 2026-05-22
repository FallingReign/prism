import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SlackStatusPanel } from "./slack-status-panel";

describe("Prism website Slack status", () => {
  it("shows Connect Slack when no identity is linked", () => {
    const html = renderToStaticMarkup(<SlackStatusPanel status={{ kind: "not_linked" }} />);

    expect(html).toContain("Not linked");
    expect(html).toContain("/v1/slack/oauth/start");
    expect(html).not.toMatch(/xox[bp]-|refresh|client_secret|access_token/i);
  });

  it("shows linked and healthy without credential material", () => {
    const html = renderToStaticMarkup(
      <SlackStatusPanel status={{ kind: "linked", status: "healthy", teamId: "T123", slackUserId: "U123", lastErrorClass: null }} />
    );

    expect(html).toContain("Linked and healthy");
    expect(html).toContain("U123");
    expect(html).not.toMatch(/xox[bp]-|refresh|client_secret|access_token/i);
  });

  it("shows organization identity when an Enterprise Grid OAuth response has no workspace id", () => {
    const html = renderToStaticMarkup(
      <SlackStatusPanel
        status={{ kind: "linked", status: "healthy", teamId: null, enterpriseId: "E123", slackUserId: "U123", lastErrorClass: null }}
      />
    );

    expect(html).toContain("Linked and healthy");
    expect(html).toContain("organization");
    expect(html).toContain("E123");
    expect(html).not.toContain("workspace <strong></strong>");
    expect(html).not.toMatch(/xox[bp]-|refresh|client_secret|access_token/i);
  });

  it("shows Reauth required and reconnect without deleting the user-facing identity", () => {
    const html = renderToStaticMarkup(
      <SlackStatusPanel
        status={{ kind: "linked", status: "reauth_required", teamId: "T123", slackUserId: "U123", lastErrorClass: "invalid_refresh_token" }}
      />
    );

    expect(html).toContain("Reauth required");
    expect(html).toContain("Reconnect Slack");
    expect(html).toContain("U123");
    expect(html).not.toMatch(/xox[bp]-|refresh-secret|client_secret|access_token/i);
  });
});
