import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ poll: vi.fn(), store: {} }));

vi.mock("../../../../../../src/server/config", () => ({
  getDeveloperTokenConfig: () => ({ pepper: "test-pepper", pepperId: "v1" })
}));
vi.mock("../../../../../../src/server/db", () => ({ database: {} }));
vi.mock("../../../../../../src/server/local-app-authorization/postgres-store", () => ({
  createPostgresLocalAppAuthorizationStore: () => mocks.store
}));
vi.mock("../../../../../../src/server/local-app-authorization/service", () => ({
  pollLocalAppAuthorization: mocks.poll
}));

describe("POST /v1/prism/local-app/authorizations/token", () => {
  beforeEach(() => {
    mocks.poll.mockReset();
    mocks.poll.mockResolvedValue({ kind: "pending" });
  });

  it("maps pending polling to a no-store 202", async () => {
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ error: "authorization_pending" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.poll).toHaveBeenCalledWith(expect.objectContaining({ sourceIdentifier: "unattributed" }));
  });

  it.each([
    [{ kind: "slow_down", retryAfterSeconds: 7 }, "slow_down", 7],
    [{ kind: "rate_limited", retryAfterSeconds: 60 }, "rate_limited", 60]
  ])("maps %o to 429 and Retry-After", async (result, error, retryAfter) => {
    mocks.poll.mockResolvedValue(result);
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(retryAfter));
    await expect(response.json()).resolves.toEqual({ error, retryAfterSeconds: retryAfter });
  });

  it.each([
    ["denied", 400, "access_denied"],
    ["expired", 400, "expired_token"],
    ["policy_denied", 403, "policy_denied"],
    ["invalid_grant", 400, "invalid_grant"]
  ])("maps terminal %s without issuing a credential", async (kind, status, error) => {
    mocks.poll.mockResolvedValue({ kind });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
  });

  it("returns the copy-once token and granted workspaces on approved exchange", async () => {
    mocks.poll.mockResolvedValue({
      kind: "issued",
      developerToken: "prism_dev_copy_once_test_value",
      tokenProfileId: "profile-1",
      clientId: "example-local-app",
      subject: {
        prismUserId: "user-1",
        installationScope: "organization",
        slackTeamId: null,
        slackEnterpriseId: "E1",
        workspaces: [{ teamId: "T1", teamName: "Studio" }]
      }
    });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      developerToken: "prism_dev_copy_once_test_value",
      subject: { workspaces: [{ teamId: "T1" }] }
    });
  });

  it("rejects extra query data and non-exact content type before polling", async () => {
    const { POST } = await import("./route");
    const response = await POST(request("https://prism.example/v1/prism/local-app/authorizations/token?extra=1", "application/json; charset=utf-8"));
    expect(response.status).toBe(400);
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it("rejects duplicate device-code keys before polling", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://prism.example/v1/prism/local-app/authorizations/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"clientId":"example-local-app","deviceCode":"${"A".repeat(43)}","deviceCode":"${"D".repeat(43)}"}`
    }));
    expect(response.status).toBe(400);
    expect(mocks.poll).not.toHaveBeenCalled();
  });
});

function request(
  url = "https://prism.example/v1/prism/local-app/authorizations/token",
  contentType = "application/json"
): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify({ clientId: "example-local-app", deviceCode: "D".repeat(43) })
  });
}
