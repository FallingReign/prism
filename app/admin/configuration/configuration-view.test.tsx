import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminConfigurationView } from "./configuration-view";

describe("Prism configuration admin view", () => {
  it("shows a redacted database-backed configuration", () => {
    const html = renderToStaticMarkup(
      <AdminConfigurationView
        configuration={{ source: "database", version: "4", secretConfigured: true, botScopes: [], userScopes: ["chat:write"], socketModeEnabled: true, socketApiAppId: "A1234567890", socketAppTokenConfigured: true, activatedAt: "2026-08-23T00:00:00.000Z", activatedBy: "Ada Admin" }}
        callbackUri="https://prism.example/v1/slack/oauth/callback"
      />
    );

    expect(html).toContain("Prism configuration");
    expect(html).toContain("Version 4");
    expect(html).toContain("Stored securely");
    expect(html).toContain("chat:write");
    expect(html).toContain("Ada Admin");
    expect(html).toContain("Socket Mode enabled");
    expect(html).not.toMatch(/client_secret|xox[bp]-|access_token|refresh_token|secret-canary/i);
  });

  it("clearly marks environment-owned credentials as locked", () => {
    const html = renderToStaticMarkup(
      <AdminConfigurationView
        configuration={{ source: "environment", secretConfigured: true, botScopes: ["users:read"], userScopes: ["chat:write"], socketModeEnabled: false, socketApiAppId: null, socketAppTokenConfigured: false, activatedAt: null, activatedBy: null }}
        callbackUri="https://prism.example/v1/slack/oauth/callback"
      />
    );

    expect(html).toContain("Environment locked");
    expect(html).toContain("cannot be replaced or revealed");
    expect(html).not.toContain("Edit secret");
  });
});
