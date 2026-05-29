import "server-only";

import type { ActivityType } from "../audit/activity";
import { insertActivityAuditRecord } from "../audit/postgres-store";
import type { Database } from "../db";
import type { AdminAuthorizationDecision, AdminScope } from "./authorization";
import { getAdminUserDetail, type AdminUserDirectoryStore } from "./user-directory";

const ADMIN_REASON_MAX_LENGTH = 240;

export type AdminSlackConnectionActionAudit = {
  endpoint: string;
  requestId: string;
  activityType: ActivityType;
  adminActorPrismUserId: string;
  adminActorSlackUserId: string;
  adminActorSlackDisplayName: string | null;
  adminReason: string;
};

export type AdminSlackConnectionActionStore = {
  removeTargetCurrentConnection(input: {
    prismUserId: string;
    slackConnectionId: string;
    audit: AdminSlackConnectionActionAudit;
    now: Date;
  }): Promise<{ kind: "removed"; connectionId: string } | { kind: "not_found" }>;
};

type RemoveAdminSlackConnectionInput = {
  decision: AdminAuthorizationDecision;
  directoryStore: AdminUserDirectoryStore;
  connectionStore: AdminSlackConnectionActionStore;
  userId: string;
  reason: string | undefined;
  confirmation: string | undefined;
  audit: { endpoint: string; requestId: string };
  now?: Date;
};

type RemoveAdminSlackConnectionResult =
  | { kind: "removed"; connectionId: string; scope: AdminScope }
  | { kind: "unauthenticated" | "forbidden" | "not_found" }
  | { kind: "validation_error"; message: string };

type CurrentSlackConnectionRow = {
  id: string;
  prism_user_id: string;
  authed_user_id: string;
  team_id: string | null;
  enterprise_id: string | null;
};

export function createPostgresAdminSlackConnectionActionStore(database: Database): AdminSlackConnectionActionStore {
  return {
    async removeTargetCurrentConnection(input) {
      return database.transaction(async (tx) => {
        const current = await tx.query<CurrentSlackConnectionRow>(
          `select id, prism_user_id, authed_user_id, nullif(team_id, '') as team_id, enterprise_id
           from slack_connections
           where id = $1 and prism_user_id = $2
           for update`,
          [input.slackConnectionId, input.prismUserId]
        );
        const row = current.rows[0];
        if (!row) return { kind: "not_found" as const };

        await insertActivityAuditRecord(tx, {
          prismUserId: row.prism_user_id,
          slackConnectionId: row.id,
          slackUserId: row.authed_user_id,
          slackTeamId: row.team_id,
          slackEnterpriseId: row.enterprise_id,
          activityType: input.audit.activityType,
          endpoint: input.audit.endpoint,
          objectType: "slack_connection",
          objectId: row.id,
          status: "deleted",
          httpStatus: 200,
          requestId: input.audit.requestId,
          upstreamCalled: false,
          adminActorPrismUserId: input.audit.adminActorPrismUserId,
          adminActorSlackUserId: input.audit.adminActorSlackUserId,
          adminActorSlackDisplayName: input.audit.adminActorSlackDisplayName,
          adminReason: input.audit.adminReason,
          occurredAt: input.now
        });

        const deleted = await tx.query(
          `delete from slack_connections
           where id = $1 and prism_user_id = $2`,
          [row.id, row.prism_user_id]
        );
        if (!deleted.rowCount) return { kind: "not_found" as const };
        return { kind: "removed" as const, connectionId: row.id };
      });
    }
  };
}

export async function removeAdminSlackConnection(input: RemoveAdminSlackConnectionInput): Promise<RemoveAdminSlackConnectionResult> {
  if (input.decision.kind === "unauthenticated") return { kind: "unauthenticated" };
  if (input.decision.kind === "not_admin") return { kind: "forbidden" };

  const validation = validateAdminActionInput(input.reason, input.confirmation);
  if (validation.kind === "validation_error") return validation;

  const detail = await getAdminUserDetail({
    decision: input.decision,
    store: input.directoryStore,
    userId: input.userId,
    profileLimit: 1,
    activityLimit: 1
  });
  if (detail.kind !== "detail") return { kind: detail.kind };
  if (!detail.detail.user.slackConnection.id || detail.detail.user.slackConnection.status === "not_linked") {
    return { kind: "not_found" };
  }

  const result = await input.connectionStore.removeTargetCurrentConnection({
    prismUserId: detail.detail.user.prismUserId,
    slackConnectionId: detail.detail.user.slackConnection.id,
    audit: {
      ...input.audit,
      activityType: "admin_slack_connection_removed",
      adminActorPrismUserId: input.decision.prismUserId,
      adminActorSlackUserId: input.decision.slackUserId,
      adminActorSlackDisplayName: input.decision.slackUserDisplayName,
      adminReason: validation.reason
    },
    now: input.now ?? new Date()
  });
  if (result.kind !== "removed") return result;
  return { kind: "removed", connectionId: result.connectionId, scope: detail.scope };
}

function validateAdminActionInput(
  reason: string | undefined,
  confirmation: string | undefined
): { kind: "valid"; reason: string } | { kind: "validation_error"; message: string } {
  if (confirmation !== "REMOVE") {
    return { kind: "validation_error", message: "Type REMOVE to confirm this admin action." };
  }
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) return { kind: "validation_error", message: "Admin reason is required." };
  if (trimmed.length > ADMIN_REASON_MAX_LENGTH) {
    return { kind: "validation_error", message: `Admin reason must be ${ADMIN_REASON_MAX_LENGTH} characters or fewer.` };
  }
  return { kind: "valid", reason: trimmed };
}
