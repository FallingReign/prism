import "server-only";

import type { Database } from "../db";
import { hashSecret } from "../slack/oauth-flow";
import {
  auditRetentionDaysFromEnv,
  buildActivityAuditRecord,
  type ActivityAuditInput,
  type ActivityAuditRecord,
  type ActivityStatus
} from "./activity";

export type ActivityAuditStore = {
  recordActivity(input: ActivityAuditInput): Promise<ActivityAuditRecord>;
  updateActivityOutcome(
    id: string,
    outcome: {
      status: ActivityStatus;
      errorClass?: string | null;
      httpStatus?: number | null;
      upstreamCalled?: boolean;
    }
  ): Promise<ActivityAuditRecord | null>;
  listRecentActivityForSession(input: { sessionToken: string | undefined; now?: Date; limit?: number }): Promise<ActivityAuditRecord[]>;
};

export class ActivityAuditUnavailableError extends Error {
  readonly operation: "record" | "update";

  constructor(operation: "record" | "update") {
    super("activity_audit_unavailable");
    this.name = "ActivityAuditUnavailableError";
    this.operation = operation;
  }
}

export function isActivityAuditUnavailableError(error: unknown): error is ActivityAuditUnavailableError {
  return error instanceof ActivityAuditUnavailableError;
}

export function createPostgresActivityAuditStore(database: Database): ActivityAuditStore {
  return {
    async recordActivity(input) {
      return insertActivityAuditRecord(database, input);
    },
    async updateActivityOutcome(id, outcome) {
      return updateActivityAuditOutcome(database, id, outcome);
    },
    async listRecentActivityForSession({ sessionToken, now = new Date(), limit = 20 }) {
      if (!sessionToken) {
        return [];
      }
      const boundedLimit = Math.max(1, Math.min(limit, 50));
      const result = await database.query<ActivityAuditRow>(
        `select a.id, a.prism_user_id, a.slack_connection_id, a.token_profile_id, a.token_profile_name,
                a.slack_user_id, a.slack_team_id, a.slack_enterprise_id, a.activity_type, a.endpoint,
                a.slack_method, a.action_category, a.surface, a.object_type, a.object_id, a.execution_mode,
                a.status, a.error_class, a.http_status, a.request_id, a.upstream_called, a.occurred_at,
                a.retention_expires_at
         from prism_sessions s
         join prism_activity_audit a on a.prism_user_id = s.prism_user_id
         where s.session_token_hash = $1
           and s.expires_at > $2
           and a.retention_expires_at > $2
         order by a.occurred_at desc
         limit $3`,
        [hashSecret(sessionToken), now, boundedLimit]
      );
      return result.rows.map(toActivityAuditRecord);
    }
  };
}

export async function insertActivityAuditRecord(database: Database, input: ActivityAuditInput): Promise<ActivityAuditRecord> {
  const record = buildActivityAuditRecord({ ...input, retentionDays: input.retentionDays ?? auditRetentionDaysFromEnv() });
  try {
    const result = await database.query<ActivityAuditRow>(
      `insert into prism_activity_audit
         (id, prism_user_id, slack_connection_id, token_profile_id, token_profile_name,
          slack_user_id, slack_team_id, slack_enterprise_id, activity_type, endpoint,
          slack_method, action_category, surface, object_type, object_id, execution_mode,
          status, error_class, http_status, request_id, upstream_called, occurred_at,
          retention_expires_at)
       values
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23)
       returning id, prism_user_id, slack_connection_id, token_profile_id, token_profile_name,
                 slack_user_id, slack_team_id, slack_enterprise_id, activity_type, endpoint,
                 slack_method, action_category, surface, object_type, object_id, execution_mode,
                 status, error_class, http_status, request_id, upstream_called, occurred_at,
                 retention_expires_at`,
      [
        record.id,
        record.prismUserId,
        record.slackConnectionId,
        record.tokenProfileId,
        record.tokenProfileName,
        record.slackUserId,
        record.slackTeamId,
        record.slackEnterpriseId,
        record.activityType,
        record.endpoint,
        record.slackMethod,
        record.actionCategory,
        record.surface,
        record.objectType,
        record.objectId,
        record.executionMode,
        record.status,
        record.errorClass,
        record.httpStatus,
        record.requestId,
        record.upstreamCalled,
        record.occurredAt,
        record.retentionExpiresAt
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ActivityAuditUnavailableError("record");
    }
    return toActivityAuditRecord(row);
  } catch (error) {
    if (isActivityAuditUnavailableError(error)) {
      throw error;
    }
    throw new ActivityAuditUnavailableError("record");
  }
}

async function updateActivityAuditOutcome(
  database: Database,
  id: string,
  outcome: {
    status: ActivityStatus;
    errorClass?: string | null;
    httpStatus?: number | null;
    upstreamCalled?: boolean;
  }
): Promise<ActivityAuditRecord | null> {
  try {
    const result = await database.query<ActivityAuditRow>(
      `update prism_activity_audit
       set status = $2,
           error_class = $3,
           http_status = $4,
           upstream_called = $5
       where id = $1
       returning id, prism_user_id, slack_connection_id, token_profile_id, token_profile_name,
                 slack_user_id, slack_team_id, slack_enterprise_id, activity_type, endpoint,
                 slack_method, action_category, surface, object_type, object_id, execution_mode,
                 status, error_class, http_status, request_id, upstream_called, occurred_at,
                 retention_expires_at`,
      [id, outcome.status, outcome.errorClass ?? null, outcome.httpStatus ?? null, outcome.upstreamCalled ?? false]
    );
    const row = result.rows[0];
    return row ? toActivityAuditRecord(row) : null;
  } catch (error) {
    if (isActivityAuditUnavailableError(error)) {
      throw error;
    }
    throw new ActivityAuditUnavailableError("update");
  }
}

type ActivityAuditRow = {
  id: string;
  prism_user_id: string | null;
  slack_connection_id: string | null;
  token_profile_id: string | null;
  token_profile_name: string | null;
  slack_user_id: string | null;
  slack_team_id: string | null;
  slack_enterprise_id: string | null;
  activity_type: ActivityAuditRecord["activityType"];
  endpoint: string | null;
  slack_method: string | null;
  action_category: string | null;
  surface: string | null;
  object_type: string | null;
  object_id: string | null;
  execution_mode: string | null;
  status: ActivityStatus;
  error_class: string | null;
  http_status: number | null;
  request_id: string | null;
  upstream_called: boolean;
  occurred_at: Date;
  retention_expires_at: Date;
};

function toActivityAuditRecord(row: ActivityAuditRow): ActivityAuditRecord {
  return {
    id: row.id,
    prismUserId: row.prism_user_id,
    slackConnectionId: row.slack_connection_id,
    tokenProfileId: row.token_profile_id,
    tokenProfileName: row.token_profile_name,
    slackUserId: row.slack_user_id,
    slackTeamId: row.slack_team_id,
    slackEnterpriseId: row.slack_enterprise_id,
    activityType: row.activity_type,
    endpoint: row.endpoint,
    slackMethod: row.slack_method,
    actionCategory: row.action_category,
    surface: row.surface,
    objectType: row.object_type,
    objectId: row.object_id,
    executionMode: row.execution_mode,
    status: row.status,
    errorClass: row.error_class,
    httpStatus: row.http_status,
    requestId: row.request_id,
    upstreamCalled: row.upstream_called,
    occurredAt: row.occurred_at,
    retentionExpiresAt: row.retention_expires_at
  };
}
