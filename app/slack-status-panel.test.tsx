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
      <SlackStatusPanel
        status={{ kind: "linked", status: "healthy", teamId: "T123", teamName: "Example Workspace", slackUserId: "U123", lastErrorClass: null }}
      />
    );

    expect(html).toContain("Slack connected");
    expect(html).toContain("Connected");
    expect(html).toContain("Example Workspace");
    expect(html).toContain("T123");
    expect(html).toContain("U123");
    expect(html).not.toContain("Linked and healthy");
    expect(html).not.toContain("Ready for forwarding");
    expect(html).not.toContain("Server custody active");
    expect(html).not.toMatch(/xox[bp]-|refresh|client_secret|access_token/i);
  });

  it("renders a compact hosted-service summary for the homepage hero", () => {
    const html = renderToStaticMarkup(
      <SlackStatusPanel
        variant="compact"
        status={{
          kind: "linked",
          status: "healthy",
          teamId: "T123",
          teamName: "Example Workspace",
          slackUserId: "U123",
          slackUserDisplayName: "Ada Lovelace",
          lastErrorClass: null
        }}
      />
    );

    expect(html).toContain("slack-status-title");
    expect(html).toContain("Slack connected");
    expect(html).toContain("Example Workspace");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("U123");
    expect(html).not.toContain('data-slot="card"');
    expect(html).not.toContain("Ready for forwarding");
    expect(html).not.toMatch(/xox[bp]-|refresh-secret|client_secret|access_token/i);
  });

  it("shows organization identity when an Enterprise Grid OAuth response has no workspace id", () => {
    const html = renderToStaticMarkup(
      <SlackStatusPanel
        status={{
          kind: "linked",
          status: "healthy",
          teamId: null,
          enterpriseId: "E123",
          enterpriseName: "Example Enterprise",
          slackUserId: "U123",
          lastErrorClass: null
        }}
      />
    );

    expect(html).toContain("Slack connected");
    expect(html).toContain("organization");
    expect(html).toContain("Example Enterprise");
    expect(html).toContain("E123");
    expect(html).not.toContain("workspace <strong></strong>");
    expect(html).not.toMatch(/xox[bp]-|refresh|client_secret|access_token/i);
  });

  it("redacts credential-shaped text from Slack display metadata", () => {
    const html = renderToStaticMarkup(
      <SlackStatusPanel
        status={{
          kind: "linked",
          status: "healthy",
          teamId: "T123",
          teamName: "Ops xoxb-secret access_token",
          slackUserId: "U123",
          lastErrorClass: null
        }}
      />
    );

    expect(html).toContain("[redacted]");
    expect(html).not.toMatch(/xox[bp]-|client_secret|access_token|refresh-secret|authorization|tokenHash|pepper/i);
  });

  it("shows Reauth required and reconnect without deleting the user-facing identity", () => {
    const html = renderToStaticMarkup(
      <SlackStatusPanel
        status={{ kind: "linked", status: "reauth_required", teamId: "T123", slackUserId: "U123", lastErrorClass: "invalid_refresh_token" }}
      />
    );

    expect(html).toContain("Reconnect Slack");
    expect(html).toContain("Reconnect needed");
    expect(html).toContain("fresh authorization");
    expect(html).toContain("U123");
    expect(html).not.toMatch(/xox[bp]-|refresh-secret|client_secret|access_token/i);
  });
});
