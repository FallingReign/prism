import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityAuditPanel } from "./activity-audit-panel";

describe("Prism website activity audit panel", () => {
  it("teaches the metadata-only audit shape when no activity exists", () => {
    const html = renderToStaticMarkup(<ActivityAuditPanel activity={[]} />);

    expect(html).toContain("No activity");
    expect(html).toContain("No forwarded or blocked calls yet");
    expect(html).toContain("Method and category");
    expect(html).toContain("Outcome and request ID");
    expect(html).toContain("Object, identity, and time");
    expect(html).toContain("Slack message text");
    expect(html).toContain("search queries");
    expect(html).toContain("file contents");
    expect(html).toContain("tokens are not stored");
  });

  it("renders dense safe metadata for Slack method activity", () => {
    const html = renderToStaticMarkup(
      <ActivityAuditPanel
        activity={[
          {
            id: "audit_forwarded",
            occurredAt: "2026-01-02T03:04:05.000Z",
            activityType: "slack_method",
            status: "forwarded",
            tokenProfileId: "profile_writer",
            tokenProfileName: "Local MCP writer",
            slackMethod: "chat.postMessage",
            actionCategory: "write",
            surface: "web_api",
            objectType: "channel",
            objectId: "C0123SAFE",
            executionMode: "user",
            errorClass: null,
            httpStatus: 200,
            upstreamCalled: true,
            requestId: "req_safe_123"
          }
        ]}
      />
    );

    expect(html).toContain("chat.postMessage");
    expect(html).toContain("Forwarded");
    expect(html).toContain('data-slot="badge"');
    expect(html).toContain("Local MCP writer");
    expect(html).toContain("2026-01-02 03:04:05 UTC");
    expect(html).toContain("write");
    expect(html).toContain("channel:C0123SAFE");
    expect(html).toContain("user");
    expect(html).toContain("req_safe_123");
    expect(html).toContain("200");
    expect(html).toContain("Slack called");
  });

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

  it("redacts credential-shaped canaries from visible audit metadata", () => {
    const html = renderToStaticMarkup(
      <ActivityAuditPanel
        activity={[
          {
            id: "audit_canary",
            occurredAt: "2026-01-03T00:00:00.000Z",
            activityType: "slack_method",
            status: "denied",
            tokenProfileId: "profile_canary",
            tokenProfileName: "Ops xoxa-admin-secret",
            slackMethod: "chat.postMessage prism_dev_hidden",
            actionCategory: "read",
            surface: "web_api",
            objectType: "channel",
            objectId: "C0123 tokenHash pepper",
            executionMode: "bot",
            errorClass: "authorization client_secret access_token",
            httpStatus: 403,
            upstreamCalled: false,
            requestId: "req_refresh-secret"
          }
        ]}
      />
    );

    expect(html).toContain("[redacted]");
    expect(html).toContain("Denied");
    expect(html).toContain('data-slot="badge"');
    expect(html).not.toMatch(/prism_dev_|tokenHash|xox[a-z]-|pepper|refresh-secret|client_secret|access_token|authorization/i);
  });
});
