import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const authorizationId = "00000000-0000-4000-8000-000000000000";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), decide: vi.fn(), store: {} }));

vi.mock("../../../src/server/db", () => ({ database: {} }));
vi.mock("../../../src/server/config", () => ({
  getSlackOAuthDeploymentConfig: () => ({ publicBaseUrl: "https://prism.example" })
}));
vi.mock("../../../src/server/local-app-authorization/postgres-store", () => ({
  createPostgresLocalAppAuthorizationStore: () => mocks.store
}));
vi.mock("../../../src/server/local-app-authorization/service", () => ({
  resolveLocalAppConsent: mocks.resolve,
  decideLocalAppAuthorization: mocks.decide,
  localAppUserCodeCookieName: (requestId: string) => `prism_local_app_user_code_${requestId}`
}));

describe("/local-app/authorize browser flow", () => {
  beforeEach(() => {
    mocks.resolve.mockReset();
    mocks.decide.mockReset();
  });

  it("carries the exact human code through OAuth in a request-scoped cookie", async () => {
    mocks.resolve.mockResolvedValue({ kind: "login_required", requestId: authorizationId });
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("https://prism.example/local-app/authorize?user_code=ABCD-2345"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://prism.example/v1/slack/oauth/start?local_app_request=${authorizationId}`
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`prism_local_app_user_code_${authorizationId}=ABCD-2345`);
    expect(cookie).toContain("Path=/local-app");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Path=/;");
  });

  it("requires and displays the browser-held code on OAuth resume, then clears it", async () => {
    mocks.resolve.mockResolvedValue({ kind: "preview", preview: preview() });
    const { GET } = await import("./route");
    const cookieName = `prism_local_app_user_code_${authorizationId}`;
    const response = await GET(new NextRequest(`https://prism.example/local-app/authorize?request=${authorizationId}`, {
      headers: { cookie: `${cookieName}=ABCD-2345; prism_session=session-secret` }
    }));

    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      requestId: authorizationId, userCode: "ABCD-2345", sessionToken: "session-secret"
    }));
    expect(await response.text()).toContain("ABCD-2345");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${cookieName}=`);
    expect(cookie).toContain("Path=/local-app");
    expect(cookie.toLowerCase()).toMatch(/max-age=0|expires=/);
  });

  it("offers Slack reconnection without losing code correlation", async () => {
    mocks.resolve.mockResolvedValue({ kind: "connection_unavailable", requestId: authorizationId });
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("https://prism.example/local-app/authorize?user_code=ABCD-2345", {
      headers: { cookie: "prism_session=stale-session" }
    }));
    const html = await response.text();
    expect(response.status).toBe(409);
    expect(html).toContain("Reconnect Slack");
    expect(html).toContain(`local_app_request=${authorizationId}`);
    expect(response.headers.get("set-cookie")).toContain(`prism_local_app_user_code_${authorizationId}=ABCD-2345`);
  });

  it("renders an already-decided request as unavailable and clears its correlation cookie", async () => {
    mocks.resolve.mockResolvedValue({ kind: "unavailable" });
    const { GET } = await import("./route");
    const cookieName = `prism_local_app_user_code_${authorizationId}`;
    const response = await GET(new NextRequest(`https://prism.example/local-app/authorize?request=${authorizationId}`, {
      headers: { cookie: `${cookieName}=ABCD-2345; prism_session=session-secret` }
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Pairing request unavailable");
    expect(response.headers.get("set-cookie")).toContain(`${cookieName}=`);
  });

  it("enforces exact form shape and same-origin browser mutation before deciding", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://prism.example/local-app/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://attacker.example",
        cookie: "prism_session=session-secret"
      },
      body: `request=${authorizationId}&decision=approve&extra=1`
    }));
    expect(response.status).toBe(403);
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["approved", 200],
    ["denied", 200],
    ["connection_unavailable", 409],
    ["unavailable", 400]
  ])("maps browser decision %s to %s", async (result, status) => {
    mocks.decide.mockResolvedValue(result);
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://prism.example/local-app/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
        cookie: "prism_session=session-secret"
      },
      body: `request=${authorizationId}&decision=approve`
    }));
    expect(response.status).toBe(status);
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("accepts Firefox no-referrer form posts with exact same-origin Fetch Metadata", async () => {
    mocks.decide.mockResolvedValue("approved");
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://prism.example/local-app/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "null",
        "sec-fetch-site": "same-origin",
        cookie: "prism_session=session-secret"
      },
      body: `request=${authorizationId}&decision=approve`
    }));

    expect(response.status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({
      requestId: authorizationId,
      sessionToken: "session-secret",
      decision: "approve",
      auditRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/)
    }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("X-Prism-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a null Origin when same-origin Fetch Metadata is absent", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("https://prism.example/local-app/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "null",
        cookie: "prism_session=session-secret"
      },
      body: `request=${authorizationId}&decision=approve`
    }));

    expect(response.status).toBe(403);
    expect(mocks.decide).not.toHaveBeenCalled();
  });
});

function preview() {
  return {
    requestId: authorizationId,
    userCode: "ABCD-2345",
    clientId: "example-local-app",
    displayName: "Example Local App",
    intendedUse: "Read and reply to Slack messages",
    expiresAt: new Date("2026-09-01T00:10:00Z"),
    rePairing: false,
    identity: {
      prismUserId: "user-1", slackConnectionId: "connection-1", slackUserId: "U1",
      slackUserDisplayName: "Person", installationScope: "workspace", teamId: "T1",
      teamName: "Studio", enterpriseId: null, enterpriseName: null
    }
  };
}
