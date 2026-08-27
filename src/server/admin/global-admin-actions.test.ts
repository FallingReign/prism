import { describe, expect, it, vi } from "vitest";

import type { AdminAuthorizationDecision } from "./authorization";
import type { Database } from "../db";
import { createPostgresGlobalAdminActionStore, grantGlobalAdmin, revokeGlobalAdmin, type GlobalAdminActionStore } from "./global-admin-actions";

const globalDecision: AdminAuthorizationDecision = {
  kind: "authorized", prismUserId: "admin_user", slackUserId: "U_ADMIN", slackUserDisplayName: "Ada Admin",
  teamId: "T_DEV", teamName: "Dev", enterpriseId: null, enterpriseName: null, scope: { kind: "global" }, authorizationSource: "persisted"
};

describe("global Prism administrator actions", () => {
  it("requires global authority and bounded confirmation metadata", async () => {
    const store = actionStore();
    await expect(grantGlobalAdmin({ decision: { ...globalDecision, scope: { kind: "team", teamId: "T_DEV" } }, store, targetPrismUserId: "target", reason: "Role change", confirmation: "GRANT", audit: {} }))
      .resolves.toEqual({ kind: "forbidden" });
    await expect(grantGlobalAdmin({ decision: globalDecision, store, targetPrismUserId: "target", reason: "", confirmation: "GRANT", audit: {} }))
      .resolves.toMatchObject({ kind: "validation_error" });
    expect(store.grant).not.toHaveBeenCalled();
  });

  it("passes only the server-derived actor into a grant and preserves idempotency", async () => {
    const store = actionStore();
    vi.mocked(store.grant).mockResolvedValue({ kind: "already_admin" });
    await expect(grantGlobalAdmin({ decision: globalDecision, store, targetPrismUserId: "target", reason: "On-call owner", confirmation: "GRANT", audit: { requestId: "req_1", endpoint: "/admin" } }))
      .resolves.toEqual({ kind: "already_admin" });
    expect(store.grant).toHaveBeenCalledWith(expect.objectContaining({
      actorPrismUserId: "admin_user", actorSlackUserId: "U_ADMIN", targetPrismUserId: "target", reason: "On-call owner"
    }));
  });

  it("blocks self-demotion before store mutation and returns store last-admin protection", async () => {
    const store = actionStore();
    await expect(revokeGlobalAdmin({ decision: globalDecision, store, targetPrismUserId: "admin_user", reason: "No longer needed", confirmation: "REMOVE", audit: {} }))
      .resolves.toEqual({ kind: "self_demotion_forbidden" });
    expect(store.revoke).not.toHaveBeenCalled();
    vi.mocked(store.revoke).mockResolvedValue({ kind: "last_admin_forbidden" });
    await expect(revokeGlobalAdmin({ decision: globalDecision, store, targetPrismUserId: "other_admin", reason: "Rotation", confirmation: "REMOVE", audit: {} }))
      .resolves.toEqual({ kind: "last_admin_forbidden" });
  });

  it("serializes a database grant and records its metadata audit in the same transaction", async () => {
    const sql: string[] = [];
    const database = recordingDatabase((query, params) => {
      sql.push(query);
      if (query.includes("select id from prism_users")) return result([{ id: "target" }]);
      if (query.includes("select revoked_at") && params?.[0] === "admin_user") return result([{ revoked_at: null }]);
      if (query.includes("select revoked_at")) return result([]);
      if (query.includes("insert into prism_activity_audit")) return result([{ id: "audit_1" }]);
      return result([]);
    });
    await expect(createPostgresGlobalAdminActionStore(database).grant({
      actorPrismUserId: "admin_user", actorSlackUserId: "U_ADMIN", actorSlackDisplayName: "Ada", actorAuthorizationSource: "persisted",
      targetPrismUserId: "target", reason: "On-call", audit: { endpoint: "/admin", requestId: "req_1" },
      now: new Date("2026-08-26T00:00:00.000Z")
    })).resolves.toEqual({ kind: "granted" });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(sql[0]).toContain("pg_advisory_xact_lock(hashtext($1))");
    expect(sql.some((query) => query.includes("claim_source") && query.includes("admin_grant"))).toBe(true);
    expect(sql.some((query) => query.includes("insert into prism_activity_audit"))).toBe(true);
  });

  it("rechecks the last-admin invariant under the shared database lock", async () => {
    const sql: string[] = [];
    const database = recordingDatabase((query, params) => {
      sql.push(query);
      if (query.includes("select revoked_at") && params?.[0] === "admin_user") return result([{ revoked_at: null }]);
      if (query.includes("select id from prism_users")) return result([{ id: "user" }]);
      if (query.includes("from prism_configuration_admins") && query.includes("order by prism_user_id")) return result([{ prism_user_id: "target" }]);
      return result([]);
    });
    await expect(createPostgresGlobalAdminActionStore(database).revoke({
      actorPrismUserId: "admin_user", actorSlackUserId: "U_ADMIN", actorSlackDisplayName: null, actorAuthorizationSource: "persisted",
      targetPrismUserId: "target", reason: "Rotation", audit: {}, now: new Date()
    })).resolves.toEqual({ kind: "last_admin_forbidden" });
    expect(sql.some((query) => query.startsWith("update prism_configuration_admins"))).toBe(false);
    expect(sql.some((query) => query.includes("insert into prism_activity_audit"))).toBe(false);
  });

  it("fails closed when a persisted actor is revoked between route authorization and the locked mutation", async () => {
    const sql: string[] = [];
    const database = recordingDatabase((query, params) => {
      sql.push(query);
      if (query.includes("select revoked_at") && params?.[0] === "admin_user") return result([{ revoked_at: new Date() }]);
      return result([]);
    });
    await expect(createPostgresGlobalAdminActionStore(database).grant({
      actorPrismUserId: "admin_user", actorSlackUserId: "U_ADMIN", actorSlackDisplayName: null, actorAuthorizationSource: "persisted",
      targetPrismUserId: "target", reason: "Role change", audit: {}
    })).resolves.toEqual({ kind: "forbidden" });
    expect(sql[0]).toContain("pg_advisory_xact_lock");
    expect(sql.some((query) => query.includes("insert into prism_configuration_admins"))).toBe(false);
    expect(sql.some((query) => query.includes("insert into prism_activity_audit"))).toBe(false);
  });

  it("allows legacy recovery to establish only the first persisted administrator", async () => {
    const first = recordingDatabase((query) => {
      if (query.includes("order by prism_user_id for update")) return result([]);
      if (query.includes("select id from prism_users")) return result([{ id: "target" }]);
      if (query.includes("select revoked_at")) return result([]);
      if (query.includes("insert into prism_activity_audit")) return result([{ id: "audit" }]);
      return result([]);
    });
    await expect(createPostgresGlobalAdminActionStore(first).grant({
      actorPrismUserId: "recovery_user", actorSlackUserId: "U_RECOVERY", actorSlackDisplayName: null, actorAuthorizationSource: "legacy_allowlist",
      targetPrismUserId: "target", reason: "Recover persisted administration", audit: {}
    })).resolves.toEqual({ kind: "granted" });

    const existing = recordingDatabase((query) => query.includes("order by prism_user_id for update")
      ? result([{ prism_user_id: "active_admin" }]) : result([]));
    await expect(createPostgresGlobalAdminActionStore(existing).grant({
      actorPrismUserId: "recovery_user", actorSlackUserId: "U_RECOVERY", actorSlackDisplayName: null, actorAuthorizationSource: "legacy_allowlist",
      targetPrismUserId: "other", reason: "Attempt second grant", audit: {}
    })).resolves.toEqual({ kind: "forbidden" });
  });
});

function actionStore(): GlobalAdminActionStore & { grant: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> } {
  return { grant: vi.fn(), revoke: vi.fn() } as unknown as GlobalAdminActionStore & { grant: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> };
}

function recordingDatabase(resolve: (sql: string, params?: unknown[]) => { rows: any[]; rowCount: number }): Database & { transaction: ReturnType<typeof vi.fn> } {
  const database = {
    query: vi.fn(async (sql: string, params?: unknown[]) => resolve(sql.toLowerCase(), params)),
    transaction: vi.fn()
  } as unknown as Database & { transaction: ReturnType<typeof vi.fn> };
  database.transaction.mockImplementation(async (callback: (tx: Database) => Promise<unknown>) => callback(database));
  return database;
}

function result(rows: any[]): { rows: any[]; rowCount: number } { return { rows, rowCount: rows.length }; }
