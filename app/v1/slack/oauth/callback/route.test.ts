import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({ query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>() }));

vi.mock("../../../../../src/server/db", () => ({ database: mockDb }));

describe("GET /v1/slack/oauth/callback", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    process.env.SLACK_CLIENT_ID = "client-id-123";
    process.env.SLACK_CLIENT_SECRET = "client-secret-must-not-appear";
    process.env.PRISM_PUBLIC_BASE_URL = "http://localhost:3732";
    process.env.SLACK_OAUTH_REDIRECT_URI = "http://localhost:3732/v1/slack/oauth/callback";
    process.env.PRISM_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
    process.env.PRISM_CREDENTIAL_ENCRYPTION_KEY_ID = "test-key";
    process.env.PRISM_SLACK_OAUTH_MOCK = "1";
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes("update slack_oauth_states")) return { rows: [{ redirect_uri: "http://localhost:3732/v1/slack/oauth/callback" }], rowCount: 1 };
      if (sql.includes("insert into prism_users")) return { rows: [{ id: "user_1" }], rowCount: 1 };
      if (sql.includes("insert into slack_connections")) return { rows: [{ id: "conn_1" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
  });

  it("exchanges a valid callback through the server path and redirects without token-bearing params", async () => {
    const { GET } = await import("./route");
    const request = new NextRequest("http://localhost:3732/v1/slack/oauth/callback?code=mock-code&state=state-123", {
      headers: { cookie: "prism_slack_oauth_state=state-123" }
    });

    const response = await GET(request);
    const location = response.headers.get("location") ?? "";
    const cookie = response.headers.get("set-cookie") ?? "";
    const visible = `${location} ${cookie}`;

    expect(response.status).toBe(302);
    expect(location).toBe("http://localhost:3732/?slack=linked");
    expect(cookie).toContain("prism_session=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(visible).not.toMatch(/xox[bp]-|refresh-secret|access_token|client-secret/i);
  });
});
