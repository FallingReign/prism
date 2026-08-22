import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
  transaction: vi.fn()
}));
const mockCookies = vi.hoisted(() => vi.fn());
const mockReadSlackStatus = vi.hoisted(() => vi.fn());

vi.mock("../src/server/db", () => ({ database: mockDb }));
vi.mock("next/headers", () => ({ cookies: mockCookies }));
vi.mock("../src/server/slack/connection-status", () => ({
  getSlackLinkStatusWithDisplayNameEnrichment: mockReadSlackStatus
}));

const tempDirs: string[] = [];

describe("/", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.query.mockResolvedValue({ rows: [adminIdentityRow()], rowCount: 1 });
    mockCookies.mockReset();
    mockCookies.mockResolvedValue({ get: () => undefined });
    mockReadSlackStatus.mockReset();
    mockReadSlackStatus.mockResolvedValue({ kind: "not_linked" });
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SLACK_CLIENT_ID", "client-id-123");
    vi.stubEnv("SLACK_CLIENT_SECRET", "homepage-client-secret-canary");
    vi.stubEnv("PRISM_PUBLIC_BASE_URL", "http://localhost:3732");
    vi.stubEnv("PRISM_OIDC_ALLOW_INSECURE_HTTP", "1");
    vi.stubEnv("SLACK_OAUTH_REDIRECT_URI", "http://localhost:3732/v1/slack/oauth/callback");
    vi.stubEnv("SLACK_USER_SCOPES", "users:read");
    vi.stubEnv("PRISM_SLACK_OAUTH_MOCK", "0");
    vi.stubEnv("PRISM_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("PRISM_CREDENTIAL_ENCRYPTION_KEY_ID", "homepage-test-key");
    delete process.env.PRISM_ADMIN_ALLOWLIST_PATH;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("renders the API reference link for normal homepage visitors", async () => {
    const { default: HomePage } = await import("./page");
    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain('href="/api-reference"');
    expect(html).toContain("API reference");
    expect(html).toContain("Install Prism skill");
    expect(html).not.toContain("Admin console");
  });

  it("derives setup-required status from invalid server config without exposing its values", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PRISM_SLACK_OAUTH_MOCK", "1");
    vi.stubEnv("SLACK_CLIENT_ID", "mock-playtest-client");
    const { default: HomePage } = await import("./page");

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Setup required");
    expect(html).toContain("Configuration needed");
    expect(html).toContain("missing or invalid");
    expect(html).not.toContain('href="/v1/slack/oauth/start"');
    expect(html).not.toContain("homepage-client-secret-canary");
    expect(html).not.toContain("mock-playtest-client");
    expect(html).not.toContain("setup-required:");
    expect(mockReadSlackStatus).not.toHaveBeenCalled();
  });

  it("shows the Admin console link only for allowlisted admin sessions", async () => {
    mockCookies.mockResolvedValue({ get: () => ({ value: "session-token" }) });
    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_ADMIN", scope: { kind: "team", teamId: "T_DEV" } }]);

    const { default: HomePage } = await import("./page");
    expect(renderToStaticMarkup(await HomePage())).toContain('href="/admin"');
    expect(renderToStaticMarkup(await HomePage())).toContain("Admin console");

    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeAllowlist([{ slackUserId: "U_OTHER", scope: { kind: "global" } }]);
    expect(renderToStaticMarkup(await HomePage())).not.toContain("Admin console");

    process.env.PRISM_ADMIN_ALLOWLIST_PATH = await writeMalformedAllowlist();
    expect(renderToStaticMarkup(await HomePage())).not.toContain("Admin console");
  });
});

function adminIdentityRow() {
  return {
    prism_user_id: "prism_user_1",
    slack_user_id: "U_ADMIN",
    slack_user_display_name: "Ada Admin",
    team_id: "T_DEV",
    team_name: "Dev Workspace",
    enterprise_id: "E_ORG",
    enterprise_name: "Dev Org"
  };
}

async function writeAllowlist(admins: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-home-page-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, JSON.stringify({ admins }), "utf8");
  return allowlistPath;
}

async function writeMalformedAllowlist(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prism-home-page-"));
  tempDirs.push(dir);
  const allowlistPath = join(dir, "admins.json");
  await writeFile(allowlistPath, "not-json", "utf8");
  return allowlistPath;
}
