import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  store: {}
}));

vi.mock("../../../../../src/server/config", () => ({
  getSlackOAuthDeploymentConfig: () => ({ publicBaseUrl: "https://prism.example" })
}));
vi.mock("../../../../../src/server/db", () => ({ database: {} }));
vi.mock("../../../../../src/server/local-app-authorization/postgres-store", () => ({
  createPostgresLocalAppAuthorizationStore: () => mocks.store
}));
vi.mock("../../../../../src/server/local-app-authorization/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../../src/server/local-app-authorization/service")>();
  return { ...original, beginLocalAppAuthorization: mocks.begin };
});

describe("POST /v1/prism/local-app/authorizations", () => {
  beforeEach(() => {
    mocks.begin.mockReset();
    mocks.begin.mockResolvedValue({
      kind: "created",
      deviceCode: "D".repeat(43),
      userCode: "ABCD-2345",
      verificationUri: "https://prism.example/local-app/authorize",
      verificationUriComplete: "https://prism.example/local-app/authorize?user_code=ABCD-2345",
      expiresAt: new Date("2026-09-01T00:10:00Z"),
      intervalSeconds: 5
    });
  });

  it("returns a no-store 201 device authorization response", async () => {
    const { POST } = await import("./route");
    const response = await POST(request(validBody()));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      deviceCode: "D".repeat(43), userCode: "ABCD-2345", intervalSeconds: 5
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({ sourceIdentifier: "unattributed" }));
  });

  it("rejects non-exact transport shapes before creating state", async () => {
    const { POST } = await import("./route");
    const response = await POST(request(validBody(), {
      url: "https://prism.example/v1/prism/local-app/authorizations?extra=1",
      contentType: "application/json; charset=utf-8"
    }));
    expect(response.status).toBe(400);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("rejects duplicate JSON keys instead of applying last-key wins", async () => {
    const { POST } = await import("./route");
    const body = JSON.stringify(validBody()).replace(
      '"clientId":"example-local-app"',
      '"clientId":"attacker","clientId":"example-local-app"'
    );
    const response = await POST(new NextRequest("https://prism.example/v1/prism/local-app/authorizations", {
      method: "POST", headers: { "content-type": "application/json" }, body
    }));
    expect(response.status).toBe(400);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("maps shared abuse control to 429 with Retry-After", async () => {
    mocks.begin.mockResolvedValue({ kind: "rate_limited" });
    const { POST } = await import("./route");
    const response = await POST(request(validBody()));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({ error: "rate_limited", retryAfterSeconds: 60 });
  });
});

function validBody() {
  return {
    clientId: "example-local-app",
    displayName: "Example Local App",
    intendedUse: "Read and reply to Slack messages",
    requestedPreset: "messages_only",
    executionIdentity: "user"
  };
}

function request(body: unknown, options?: { url?: string; contentType?: string }): NextRequest {
  return new NextRequest(options?.url ?? "https://prism.example/v1/prism/local-app/authorizations", {
    method: "POST",
    headers: { "content-type": options?.contentType ?? "application/json" },
    body: JSON.stringify(body)
  });
}
