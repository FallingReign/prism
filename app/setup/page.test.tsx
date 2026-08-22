import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCookies = vi.hoisted(() => vi.fn());
const mockStatus = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: mockCookies }));
vi.mock("../../src/server/slack/app-configuration-factory", () => ({
  createConfiguredSlackAppConfigurationResolver: () => ({ getStatus: mockStatus })
}));

describe("/setup page", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PRISM_PUBLIC_BASE_URL", "http://localhost:3732");
    vi.stubEnv("PRISM_OIDC_ALLOW_INSECURE_HTTP", "1");
    vi.stubEnv("SLACK_OAUTH_REDIRECT_URI", "http://localhost:3732/v1/slack/oauth/callback");
    mockCookies.mockResolvedValue({ get: () => undefined });
    mockStatus.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("shows code entry for setup-required and development-mock deployments", async () => {
    mockStatus.mockResolvedValue({ kind: "setup_required", developmentMockAvailable: true });
    const { default: SetupPage } = await import("./page");
    const html = renderToStaticMarkup(await SetupPage({}));

    expect(html).toContain("Enter your one-time setup code");
    expect(html).toContain("http://localhost:3732/v1/slack/oauth/callback");
    expect(html).not.toContain("Environment locked");
  });

  it("shows a real environment bundle as read-only without its values", async () => {
    mockStatus.mockResolvedValue({ kind: "environment_locked", summary: { botScopes: [], userScopes: ["chat:write"] } });
    const { default: SetupPage } = await import("./page");
    const html = renderToStaticMarkup(await SetupPage({}));

    expect(html).toContain("Environment locked");
    expect(html).toContain("chat:write");
    expect(html).not.toMatch(/client_secret|secret-canary|xox[bp]-|access_token|refresh_token/i);
  });

  it("shows completion instead of reopening bootstrap after activation", async () => {
    mockStatus.mockResolvedValue({ kind: "active", summary: {} });
    const { default: SetupPage } = await import("./page");
    const html = renderToStaticMarkup(await SetupPage({}));

    expect(html).toContain("Slack configuration is active");
    expect(html).toContain("View configuration");
  });
});
