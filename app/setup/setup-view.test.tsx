import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SetupView, type SetupScopeOption } from "./setup-view";

const scopes: SetupScopeOption[] = [
  { id: "channels:read", label: "View public channels", description: "Read channel names and membership.", tokenKind: "bot", required: false },
  { id: "chat:write", label: "Send messages as you", description: "Send Playtest announcements using your Slack identity.", tokenKind: "user", required: true },
  { id: "search:read", label: "Search messages", description: "Search content visible to the signed-in user.", tokenKind: "user", required: false }
];

describe("Prism setup view", () => {
  it("renders only a generic one-time code form before a setup session exists", () => {
    const html = renderToStaticMarkup(<SetupView state={{ kind: "code_required" }} callbackUri="http://localhost:3732/v1/slack/oauth/callback" />);

    expect(html).toContain("Enter your one-time setup code");
    expect(html).toContain('action="/v1/prism/setup/session"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="setupProof"');
    expect(html).toContain('type="password"');
    expect(html).toContain("http://localhost:3732/v1/slack/oauth/callback");
    expect(html).not.toMatch(/client_secret|xox[bp]-|access_token|refresh_token/i);
  });

  it("renders friendly rate-limit and expired-session guidance", () => {
    const rateLimited = renderToStaticMarkup(<SetupView state={{ kind: "code_required", error: "rate_limited" }} callbackUri="http://localhost:3732/v1/slack/oauth/callback" />);
    const expired = renderToStaticMarkup(<SetupView state={{ kind: "code_required", error: "session_expired" }} callbackUri="http://localhost:3732/v1/slack/oauth/callback" />);

    expect(rateLimited).toContain("Too many setup attempts");
    expect(expired).toContain("setup session expired");
  });

  it("renders structured credential and scope controls for an authorized setup session", () => {
    const html = renderToStaticMarkup(
      <SetupView callbackUri="http://localhost:3732/v1/slack/oauth/callback" state={{ kind: "configure", scopes, selectedBotScopes: [], selectedUserScopes: ["chat:write"], pending: null }} />
    );

    expect(html).toContain("Slack Client ID");
    expect(html).toContain("Slack Client Secret");
    expect(html).toContain('name="clientSecret"');
    expect(html).toContain('type="password"');
    expect(html).toContain("User scopes");
    expect(html).toContain("Bot scopes");
    expect(html).toContain("Select all Prism-supported");
    expect(html).toContain("Reset to default");
    expect(html).toContain("There is no Slack all-scopes wildcard");
    expect(html).toContain("must already be configured and approved");
    expect(html).toContain("defaults to every scope in this reviewed list");
    expect(html).toContain('value="chat:write"');
    expect(html).toContain('action="/v1/prism/setup/slack-configuration"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="userScope"');
    expect(html).toContain('name="botScope"');
    expect(html).toContain('name="additionalUserScopes"');
    expect(html).toContain('name="additionalBotScopes"');
    expect(html).not.toContain('value="*"');
  });

  it("shows a saved candidate as not verified without rendering its secret", () => {
    const html = renderToStaticMarkup(
      <SetupView
        callbackUri="http://localhost:3732/v1/slack/oauth/callback"
        state={{ kind: "configure", scopes, selectedBotScopes: [], selectedUserScopes: ["chat:write"], pending: { clientId: "123.456", secretStored: true, botScopes: [], userScopes: ["chat:write"], socketModeEnabled: false, socketApiAppId: null, socketAppTokenConfigured: false, version: "2" } }}
      />
    );

    expect(html).toContain("Not verified");
    expect(html).toContain("Stored securely");
    expect(html).toContain("Preparing secure verification");
    expect(html).toContain('action="/v1/prism/setup/slack-configuration/verify"');
    expect(html).toContain('name="setupProof"');
    expect(html).not.toMatch(/client_secret|secret-canary|xox[bp]-|access_token|refresh_token/i);
  });

  it("renders environment-owned configuration as read-only", () => {
    const html = renderToStaticMarkup(<SetupView callbackUri="https://prism.example/v1/slack/oauth/callback" state={{ kind: "environment_locked", botScopes: [], userScopes: ["chat:write"] }} />);

    expect(html).toContain("Environment locked");
    expect(html).toContain("managed by this deployment");
    expect(html).not.toContain("Slack Client Secret");
    expect(html).not.toContain("Save Slack configuration");
  });
});
