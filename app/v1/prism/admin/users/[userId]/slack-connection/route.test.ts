import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAdminAllowlist: vi.fn(() => ({ entries: [] })),
  randomUUID: vi.fn(() => "req_route"),
  removeAdminSlackConnection: vi.fn(),
  resolvePrismAdmin: vi.fn()
}));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, randomUUID: mocks.randomUUID };
});

vi.mock("../../../../../../../src/server/admin/allowlist", () => ({
  AdminAllowlistUnavailableError: class AdminAllowlistUnavailableError extends Error {},
  loadAdminAllowlist: mocks.loadAdminAllowlist
}));

vi.mock("../../../../../../../src/server/admin/slack-connection-actions", () => ({
  createPostgresAdminSlackConnectionActionStore: vi.fn(() => ({ kind: "postgres-store" })),
  removeAdminSlackConnection: mocks.removeAdminSlackConnection
}));

vi.mock("../../../../../../../src/server/admin/authorization", () => ({
  resolvePrismAdmin: mocks.resolvePrismAdmin
}));

vi.mock("../../../../../../../src/server/admin/postgres-store", () => ({
  createPostgresAdminIdentityStore: vi.fn(() => ({ kind: "identity-store" }))
}));

vi.mock("../../../../../../../src/server/admin/postgres-user-directory-store", () => ({
  createPostgresAdminUserDirectoryStore: vi.fn(() => ({ kind: "user-directory-store" }))
}));

vi.mock("../../../../../../../src/server/db", () => ({
  database: { kind: "database" }
}));

vi.mock("../../../../../../../src/server/audit/postgres-store", () => ({
  isActivityAuditUnavailableError: vi.fn(() => false)
}));

describe("DELETE /v1/prism/admin/users/[userId]/slack-connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAdminAllowlist.mockReturnValue({ entries: [] });
    mocks.randomUUID.mockReturnValue("req_route");
  });

  it("removes the target Slack connection with admin actor and required reason metadata", async () => {
    const decision = {
      kind: "authorized",
      prismUserId: "admin_user",
      slackUserId: "U_ADMIN",
      slackUserDisplayName: "Ada Admin",
      teamId: "T_TARGET",
      teamName: "Target Team",
      enterpriseId: null,
      enterpriseName: null,
      scope: { kind: "team", teamId: "T_TARGET" }
    } as const;
    mocks.resolvePrismAdmin.mockResolvedValue(decision);
    mocks.removeAdminSlackConnection.mockResolvedValue({ kind: "removed", connectionId: "conn_1", scope: { kind: "team", teamId: "T_TARGET" } });

    const { DELETE } = await import("./route");
    const response = await DELETE(
      new NextRequest("http://localhost/v1/prism/admin/users/target_user/slack-connection", {
        method: "DELETE",
        headers: { cookie: "prism_session=session-token" },
        body: JSON.stringify({ confirmation: "REMOVE", reason: "Security offboarding" })
      }),
      { params: Promise.resolve({ userId: "target_user" }) }
    );

    expect(randomUUID()).toBe("req_route");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Prism-Request-ID")).toBe("req_route");
    await expect(response.json()).resolves.toEqual({ status: "removed", scope: { kind: "team", teamId: "T_TARGET" } });
    expect(mocks.removeAdminSlackConnection).toHaveBeenCalledWith({
      decision,
      userId: "target_user",
      confirmation: "REMOVE",
      reason: "Security offboarding",
      audit: { endpoint: "/v1/prism/admin/users/target_user/slack-connection", requestId: "req_route" },
      connectionStore: { kind: "postgres-store" },
      directoryStore: { kind: "user-directory-store" }
    });
    expect(mocks.resolvePrismAdmin).toHaveBeenCalledWith({
      allowlist: { entries: [] },
      store: { kind: "identity-store" },
      sessionToken: "session-token"
    });
  });

  it("maps invalid JSON and action errors without returning sensitive details", async () => {
    const { DELETE } = await import("./route");
    const invalidJson = await DELETE(
      new NextRequest("http://localhost/v1/prism/admin/users/target_user/slack-connection", {
        method: "DELETE",
        body: "{"
      }),
      { params: Promise.resolve({ userId: "target_user" }) }
    );
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ error: "invalid_json" });
    expect(mocks.removeAdminSlackConnection).not.toHaveBeenCalled();

    mocks.resolvePrismAdmin.mockResolvedValue({ kind: "authorized", prismUserId: "admin_user", slackUserId: "U_ADMIN", slackUserDisplayName: null, teamId: "T_TARGET", teamName: null, enterpriseId: null, enterpriseName: null, scope: { kind: "team", teamId: "T_TARGET" } });
    mocks.removeAdminSlackConnection
      .mockResolvedValueOnce({ kind: "validation_error", message: "Type REMOVE to confirm this admin action." })
      .mockResolvedValueOnce({ kind: "forbidden" })
      .mockResolvedValueOnce({ kind: "not_found" });

    const validation = await removeRequest(DELETE);
    const forbidden = await removeRequest(DELETE);
    const notFound = await removeRequest(DELETE);

    expect(validation.status).toBe(400);
    const validationBody = await validation.json();
    expect(validationBody).toEqual({ error: "validation_error", message: "Type REMOVE to confirm this admin action." });
    expect(forbidden.status).toBe(403);
    const forbiddenBody = await forbidden.json();
    expect(forbiddenBody).toEqual({ error: "forbidden" });
    expect(notFound.status).toBe(404);
    const notFoundBody = await notFound.json();
    expect(notFoundBody).toEqual({ error: "not_found" });
    expect(JSON.stringify([validationBody, forbiddenBody, notFoundBody])).not.toMatch(/prism_dev_|xox[bp]-|access_token|refresh_token|refreshToken|client_secret|token_hash|pepper/i);
  });
});

function removeRequest(
  DELETE: typeof import("./route").DELETE,
  body: Record<string, string> = { confirmation: "REMOVE", reason: "Security offboarding" }
): Promise<Response> {
  return DELETE(
    new NextRequest("http://localhost/v1/prism/admin/users/target_user/slack-connection", {
      method: "DELETE",
      headers: { cookie: "prism_session=session-token" },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ userId: "target_user" }) }
  );
}
