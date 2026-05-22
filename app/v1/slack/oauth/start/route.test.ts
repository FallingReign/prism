import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({ query: vi.fn<() => Promise<unknown>>() }));

vi.mock("../../../../../src/server/db", () => ({ database: mockDb }));

describe("GET /v1/slack/oauth/start", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    process.env.SLACK_CLIENT_ID = "client-id-123";
    process.env.SLACK_CLIENT_SECRET = "client-secret-must-not-appear";
    process.env.PRISM_PUBLIC_BASE_URL = "http://localhost:3732";
    process.env.SLACK_OAUTH_REDIRECT_URI = "http://localhost:3732/v1/slack/oauth/callback";
  });

  it("redirects to Slack authorize with state cookie and no client secret", async () => {
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const { GET } = await import("./route");

    const response = await GET();
    const location = response.headers.get("location") ?? "";
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(location).toContain("https://slack.com/oauth/v2/authorize");
    expect(location).toContain("client_id=client-id-123");
    expect(location).toContain("state=");
    expect(cookie).toContain("prism_slack_oauth_state=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(`${location} ${cookie}`).not.toContain("client-secret-must-not-appear");
  });
});
