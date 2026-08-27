import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolvePrismAdmin: vi.fn(), grant: vi.fn(), revoke: vi.fn(), isAuditError: vi.fn((_candidate?: unknown) => false) }));
vi.mock("../../../../../../../src/server/admin/allowlist", () => ({ AdminAllowlistUnavailableError: class extends Error {}, loadAdminAllowlist: vi.fn() }));
vi.mock("../../../../../../../src/server/admin/authorization", () => ({ resolvePrismAdmin: mocks.resolvePrismAdmin }));
vi.mock("../../../../../../../src/server/admin/postgres-store", () => ({ createPostgresAdminIdentityStore: vi.fn(() => ({})) }));
vi.mock("../../../../../../../src/server/admin/global-admin-actions", () => ({ createPostgresGlobalAdminActionStore: vi.fn(() => ({})), grantGlobalAdmin: mocks.grant, revokeGlobalAdmin: mocks.revoke }));
vi.mock("../../../../../../../src/server/audit/postgres-store", () => ({ isActivityAuditUnavailableError: mocks.isAuditError }));
vi.mock("../../../../../../../src/server/db", () => ({ database: {} }));

describe("global administrator mutation route", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.resolvePrismAdmin.mockResolvedValue({ kind: "authorized", scope: { kind: "global" } }); });

  it("rejects cross-origin mutations before authorization", async () => {
    const { PUT } = await import("./route");
    const response = await PUT(new NextRequest("http://localhost/v1/prism/admin/users/target/global-admin", { method: "PUT", headers: { origin: "http://evil.example" }, body: JSON.stringify({ confirmation: "GRANT", reason: "Owner" }) }), { params: { userId: "target" } });
    expect(response.status).toBe(403);
    expect(mocks.resolvePrismAdmin).not.toHaveBeenCalled();
  });

  it("grants and revokes with no-store responses", async () => {
    mocks.grant.mockResolvedValue({ kind: "granted" });
    mocks.revoke.mockResolvedValue({ kind: "revoked" });
    const { PUT, DELETE } = await import("./route");
    const granted = await request(PUT, "PUT", { confirmation: "GRANT", reason: "On-call" });
    const revoked = await request(DELETE, "DELETE", { confirmation: "REMOVE", reason: "Rotation" });
    expect(granted.status).toBe(200);
    expect(granted.headers.get("Cache-Control")).toBe("no-store");
    await expect(granted.json()).resolves.toEqual({ status: "granted" });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ status: "revoked" });
  });

  it("maps self and last-admin conflicts", async () => {
    mocks.revoke.mockResolvedValueOnce({ kind: "self_demotion_forbidden" }).mockResolvedValueOnce({ kind: "last_admin_forbidden" });
    const { DELETE } = await import("./route");
    const self = await request(DELETE, "DELETE", { confirmation: "REMOVE", reason: "Role change" });
    const last = await request(DELETE, "DELETE", { confirmation: "REMOVE", reason: "Role change" });
    expect(self.status).toBe(409);
    expect(last.status).toBe(409);
    expect(await self.json()).toEqual({ error: "self_demotion_forbidden" });
    expect(await last.json()).toEqual({ error: "last_admin_forbidden" });
  });

  it("maps unauthenticated, non-global, idempotent, and missing results", async () => {
    mocks.grant
      .mockResolvedValueOnce({ kind: "unauthenticated" })
      .mockResolvedValueOnce({ kind: "forbidden" })
      .mockResolvedValueOnce({ kind: "already_admin" })
      .mockResolvedValueOnce({ kind: "not_found" });
    const { PUT } = await import("./route");
    expect((await request(PUT, "PUT", { confirmation: "GRANT", reason: "Role" })).status).toBe(401);
    expect((await request(PUT, "PUT", { confirmation: "GRANT", reason: "Role" })).status).toBe(403);
    const idempotent = await request(PUT, "PUT", { confirmation: "GRANT", reason: "Role" });
    expect(idempotent.status).toBe(200);
    await expect(idempotent.json()).resolves.toEqual({ status: "already_admin" });
    expect((await request(PUT, "PUT", { confirmation: "GRANT", reason: "Role" })).status).toBe(404);
  });

  it("returns audit-unavailable without reporting a successful mutation", async () => {
    const error = new Error("audit unavailable");
    mocks.grant.mockRejectedValue(error);
    mocks.isAuditError.mockImplementation((candidate: unknown) => candidate === error);
    const { PUT } = await import("./route");
    const response = await request(PUT, "PUT", { confirmation: "GRANT", reason: "Role" });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "audit_unavailable" });
  });
});

function request(handler: typeof import("./route").PUT, method: string, body: unknown): Promise<Response> {
  return handler(new NextRequest("http://localhost/v1/prism/admin/users/target/global-admin", { method, headers: { "sec-fetch-site": "same-origin", cookie: "prism_session=session-token" }, body: JSON.stringify(body) }), { params: { userId: "target" } });
}
