import "server-only";

import type { ActivityAuditInput } from "../audit/activity";
import { insertActivityAuditRecord } from "../audit/postgres-store";
import type { Database } from "../db";
import type { AdminAuthorizationDecision } from "./authorization";

const ADMIN_REASON_MAX_LENGTH = 240;
const GLOBAL_ADMIN_ADVISORY_LOCK = "prism:configuration-admin-claim";

type ActionAudit = Pick<ActivityAuditInput, "endpoint" | "requestId">;
type ActorInput = {
  actorPrismUserId: string;
  actorSlackUserId: string;
  actorSlackDisplayName: string | null;
  actorAuthorizationSource: "persisted" | "legacy_allowlist";
  targetPrismUserId: string;
  reason: string;
  audit: ActionAudit;
  now?: Date;
};

export type GlobalAdminGrantResult = { kind: "granted" } | { kind: "already_admin" } | { kind: "not_found" } | { kind: "forbidden" };
export type GlobalAdminRevokeResult =
  | { kind: "revoked" }
  | { kind: "not_admin" }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "self_demotion_forbidden" }
  | { kind: "last_admin_forbidden" };

export type GlobalAdminActionStore = {
  grant(input: ActorInput): Promise<GlobalAdminGrantResult>;
  revoke(input: ActorInput): Promise<GlobalAdminRevokeResult>;
};

type ServiceResult<T> =
  | T
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "validation_error"; message: string };

export async function grantGlobalAdmin(input: {
  decision: AdminAuthorizationDecision;
  store: GlobalAdminActionStore;
  targetPrismUserId: string;
  reason?: string;
  confirmation?: string;
  audit: ActionAudit;
}): Promise<ServiceResult<GlobalAdminGrantResult>> {
  const authorized = authorize(input.decision);
  if (authorized) return authorized;
  const validation = validateAction(input.targetPrismUserId, input.reason, input.confirmation, "GRANT");
  if (validation.kind === "validation_error") return validation;
  return input.store.grant(actorInput(input.decision, validation, input.audit));
}

export async function revokeGlobalAdmin(input: {
  decision: AdminAuthorizationDecision;
  store: GlobalAdminActionStore;
  targetPrismUserId: string;
  reason?: string;
  confirmation?: string;
  audit: ActionAudit;
}): Promise<ServiceResult<GlobalAdminRevokeResult>> {
  const authorized = authorize(input.decision);
  if (authorized) return authorized;
  const validation = validateAction(input.targetPrismUserId, input.reason, input.confirmation, "REMOVE");
  if (validation.kind === "validation_error") return validation;
  if (input.decision.kind === "authorized" && input.decision.prismUserId === validation.targetPrismUserId) {
    return { kind: "self_demotion_forbidden" };
  }
  return input.store.revoke(actorInput(input.decision, validation, input.audit));
}

export function createPostgresGlobalAdminActionStore(database: Database): GlobalAdminActionStore {
  return {
    async grant(input) {
      return database.transaction(async (tx) => {
        await acquireAdminLock(tx);
        const actorAuthority = await revalidateActorAuthority(tx, input);
        if (!actorAuthority) return { kind: "forbidden" };
        const target = await lockUser(tx, input.targetPrismUserId);
        if (!target) return { kind: "not_found" };
        const existing = await lockGrant(tx, input.targetPrismUserId);
        if (existing?.revoked_at === null) return { kind: "already_admin" };
        const now = input.now ?? new Date();
        await tx.query(
          `insert into prism_configuration_admins
             (prism_user_id, role, claim_source, created_at, revoked_at,
              granted_by_prism_user_id, revoked_by_prism_user_id, grant_reason, revoke_reason)
           values ($1, 'global_configuration_admin', 'admin_grant', $2, null, $3, null, $4, null)
           on conflict (prism_user_id) do update
             set role = excluded.role, claim_source = excluded.claim_source, created_at = excluded.created_at,
                 revoked_at = null, granted_by_prism_user_id = excluded.granted_by_prism_user_id,
                 revoked_by_prism_user_id = null, grant_reason = excluded.grant_reason, revoke_reason = null`,
          [input.targetPrismUserId, now, input.actorPrismUserId, input.reason]
        );
        await recordActionAudit(tx, input, "admin_global_admin_granted", "created", now);
        return { kind: "granted" };
      });
    },
    async revoke(input) {
      return database.transaction(async (tx) => {
        await acquireAdminLock(tx);
        const actorAuthority = await revalidateActorAuthority(tx, input);
        if (!actorAuthority) return { kind: "forbidden" };
        await lockUser(tx, input.actorPrismUserId);
        const target = await lockUser(tx, input.targetPrismUserId);
        if (!target) return { kind: "not_found" };
        if (input.actorPrismUserId === input.targetPrismUserId) return { kind: "self_demotion_forbidden" };
        const grants = await tx.query<{ prism_user_id: string }>(
          `select prism_user_id from prism_configuration_admins
           where role = 'global_configuration_admin' and revoked_at is null
           order by prism_user_id for update`
        );
        if (!grants.rows.some((row) => row.prism_user_id === input.targetPrismUserId)) return { kind: "not_admin" };
        if (grants.rows.length <= 1) return { kind: "last_admin_forbidden" };
        const now = input.now ?? new Date();
        await tx.query(
          `update prism_configuration_admins
           set revoked_at = $2, revoked_by_prism_user_id = $3, revoke_reason = $4
           where prism_user_id = $1 and revoked_at is null`,
          [input.targetPrismUserId, now, input.actorPrismUserId, input.reason]
        );
        await recordActionAudit(tx, input, "admin_global_admin_revoked", "revoked", now);
        return { kind: "revoked" };
      });
    }
  };
}

function authorize(decision: AdminAuthorizationDecision): { kind: "unauthenticated" } | { kind: "forbidden" } | null {
  if (decision.kind === "unauthenticated") return { kind: "unauthenticated" };
  if (decision.kind !== "authorized" || decision.scope.kind !== "global") return { kind: "forbidden" };
  if (decision.authorizationSource !== "persisted" && decision.authorizationSource !== "legacy_allowlist") return { kind: "forbidden" };
  return null;
}

function validateAction(targetPrismUserId: string, reason: string | undefined, confirmation: string | undefined, expected: "GRANT" | "REMOVE"):
  | { kind: "valid"; targetPrismUserId: string; reason: string }
  | { kind: "validation_error"; message: string } {
  const target = targetPrismUserId.trim();
  if (!target) return { kind: "validation_error", message: "Target Prism user is required." };
  if (confirmation !== expected) return { kind: "validation_error", message: `Type ${expected} to confirm this admin action.` };
  const trimmedReason = reason?.trim() ?? "";
  if (!trimmedReason) return { kind: "validation_error", message: "Admin reason is required." };
  if (trimmedReason.length > ADMIN_REASON_MAX_LENGTH) return { kind: "validation_error", message: `Admin reason must be ${ADMIN_REASON_MAX_LENGTH} characters or fewer.` };
  return { kind: "valid", targetPrismUserId: target, reason: trimmedReason };
}

function actorInput(
  decision: AdminAuthorizationDecision,
  validation: { targetPrismUserId: string; reason: string },
  audit: ActionAudit
): ActorInput {
  if (decision.kind !== "authorized") throw new Error("admin-authorization-invariant");
  const authorizationSource = decision.authorizationSource;
  if (authorizationSource !== "persisted" && authorizationSource !== "legacy_allowlist") throw new Error("admin-authorization-source-invariant");
  return {
    actorPrismUserId: decision.prismUserId,
    actorSlackUserId: decision.slackUserId,
    actorSlackDisplayName: decision.slackUserDisplayName,
    actorAuthorizationSource: authorizationSource,
    targetPrismUserId: validation.targetPrismUserId,
    reason: validation.reason,
    audit
  };
}

async function acquireAdminLock(database: Database): Promise<void> {
  await database.query("select pg_advisory_xact_lock(hashtext($1))", [GLOBAL_ADMIN_ADVISORY_LOCK]);
}

async function lockUser(database: Database, prismUserId: string): Promise<boolean> {
  const result = await database.query<{ id: string }>("select id from prism_users where id = $1 for update", [prismUserId]);
  return Boolean(result.rows[0]);
}

async function lockGrant(database: Database, prismUserId: string): Promise<{ revoked_at: Date | null } | null> {
  const result = await database.query<{ revoked_at: Date | null }>(
    "select revoked_at from prism_configuration_admins where prism_user_id = $1 for update",
    [prismUserId]
  );
  return result.rows[0] ?? null;
}

async function revalidateActorAuthority(database: Database, input: ActorInput): Promise<boolean> {
  if (input.actorAuthorizationSource === "persisted") {
    const actorGrant = await lockGrant(database, input.actorPrismUserId);
    return actorGrant?.revoked_at === null;
  }

  // The legacy allowlist is break-glass compatibility only. It can bootstrap
  // the first persisted administrator, but cannot mutate grants once persisted
  // authority exists.
  const active = await database.query<{ prism_user_id: string }>(
    `select prism_user_id from prism_configuration_admins
     where role = 'global_configuration_admin' and revoked_at is null
     order by prism_user_id for update`
  );
  return active.rows.length === 0;
}

async function recordActionAudit(
  database: Database,
  input: ActorInput,
  activityType: "admin_global_admin_granted" | "admin_global_admin_revoked",
  status: "created" | "revoked",
  now: Date
): Promise<void> {
  await insertActivityAuditRecord(database, {
    prismUserId: input.targetPrismUserId,
    activityType,
    status,
    objectType: "global_admin",
    objectId: input.targetPrismUserId,
    surface: "prism_admin_users",
    endpoint: input.audit.endpoint,
    requestId: input.audit.requestId,
    upstreamCalled: false,
    adminActorPrismUserId: input.actorPrismUserId,
    adminActorSlackUserId: input.actorSlackUserId,
    adminActorSlackDisplayName: input.actorSlackDisplayName,
    adminReason: input.reason,
    occurredAt: now
  });
}
