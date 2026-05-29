import "server-only";

import type { ActivityAuditSummary } from "../audit/presentation";
import type { Database } from "../db";
import type { CapabilityMap, ExecutionIdentity, TokenProfilePreset } from "../token-profiles/presets";
import type { TokenProfileSummary } from "../../../app/token-profile-summary";
import type { AdminScope } from "./authorization";
import type { AdminUserDetail, AdminUserDirectoryRow, AdminUserDirectoryStore } from "./user-directory";

export function createPostgresAdminUserDirectoryStore(database: Database): AdminUserDirectoryStore {
  return {
    async listUsers(input) {
      const scoped = scopedUsersQuery(input.scope, boundedLimit(input.limit, 1, 100));
      const result = await database.query<AdminUserRow>(scoped.sql, scoped.params);
      return result.rows.map(toDirectoryRow);
    },
    async getUserDetail(input) {
      const scoped = scopedUsersQuery(input.scope, 1, input.userId);
      const userResult = await database.query<AdminUserRow>(scoped.sql, scoped.params);
      const user = userResult.rows[0];
      if (!user) return null;
      const profileLimit = boundedLimit(input.profileLimit, 1, 100);
      const activityLimit = boundedLimit(input.activityLimit, 1, 50);
      const [profiles, activity] = await Promise.all([
        database.query<TokenProfileAdminRow>(`${profileSummarySelect()} limit $3`, [user.prism_user_id, user.slack_connection_id, profileLimit]),
        database.query<ActivityAdminRow>(`${activitySummarySelect()} limit $3`, [user.prism_user_id, user.slack_connection_id, activityLimit])
      ]);
      return {
        user: toDirectoryRow(user),
        profiles: profiles.rows.map(toTokenProfileSummary),
        activity: activity.rows.map(toActivitySummary)
      };
    }
  };
}

function scopedUsersQuery(scope: AdminScope, limit: number, userId?: string): { sql: string; params: unknown[] } {
  const scopeFilter = scopePredicate(scope);
  const params = [...scopeFilter.params];
  const userPredicate = userId ? ` and u.id = $${params.push(userId)}` : "";
  const limitParameter = `$${params.push(limit)}`;
  return {
    sql: `${directorySelect()} where ${scopeFilter.sql}${userPredicate} order by coalesce(la.latest_activity_at, lc.updated_at) desc limit ${limitParameter}`,
    params
  };
}

function scopePredicate(scope: AdminScope): { sql: string; params: unknown[] } {
  if (scope.kind === "global") return { sql: "true", params: [] };
  if (scope.kind === "enterprise") return { sql: "lc.enterprise_id = $1", params: [scope.enterpriseId] };
  return { sql: "lc.team_id = $1", params: [scope.teamId] };
}

function directorySelect(): string {
  return `with latest_connection as (
            select distinct on (c.prism_user_id)
                   c.id, c.prism_user_id, nullif(c.team_id, '') as team_id, nullif(c.team_name, '') as team_name,
                   c.enterprise_id, nullif(c.enterprise_name, '') as enterprise_name,
                   c.authed_user_id, nullif(c.authed_user_display_name, '') as authed_user_display_name,
                   c.status, c.last_error_class, c.updated_at
            from slack_connections c
            order by c.prism_user_id, c.updated_at desc
          ),
          latest_token as (
            select distinct on (token_profile_id)
                   token_profile_id, created_at, expires_at, revoked_at
            from prism_developer_tokens
            order by token_profile_id, is_current desc, created_at desc
          ),
          token_profile_counts as (
            select p.prism_user_id, p.slack_connection_id,
                   count(*) filter (where p.status = 'active')::int as token_profile_active_count,
                   count(*) filter (where p.status = 'revoked')::int as token_profile_revoked_count,
                   count(*) filter (where p.status = 'active' and lt.created_at is not null and lt.revoked_at is null and (lt.expires_at is null or lt.expires_at > now()))::int as active_developer_token_count,
                   count(*) filter (where lt.expires_at is not null and lt.expires_at <= now() and lt.revoked_at is null)::int as expired_developer_token_count,
                   count(*) filter (where lt.revoked_at is not null)::int as revoked_developer_token_count
            from token_profiles p
            left join latest_token lt on lt.token_profile_id = p.id
            where p.status in ('active', 'revoked')
            group by p.prism_user_id, p.slack_connection_id
          ),
          latest_activity as (
            select prism_user_id, slack_connection_id, max(occurred_at) as latest_activity_at
            from prism_activity_audit
            where retention_expires_at > now()
            group by prism_user_id, slack_connection_id
          )
          select u.id as prism_user_id,
                 lc.authed_user_id as slack_user_id,
                 lc.authed_user_display_name as slack_user_display_name,
                 lc.team_id,
                 lc.team_name,
                 lc.enterprise_id,
                 lc.enterprise_name,
                 lc.id as slack_connection_id,
                 lc.status as slack_connection_status,
                 lc.last_error_class as slack_connection_last_error_class,
                 lc.updated_at as slack_connection_updated_at,
                 coalesce(tpc.token_profile_active_count, 0)::int as token_profile_active_count,
                 coalesce(tpc.token_profile_revoked_count, 0)::int as token_profile_revoked_count,
                 coalesce(tpc.active_developer_token_count, 0)::int as active_developer_token_count,
                 coalesce(tpc.expired_developer_token_count, 0)::int as expired_developer_token_count,
                 coalesce(tpc.revoked_developer_token_count, 0)::int as revoked_developer_token_count,
                 la.latest_activity_at
          from prism_users u
          join latest_connection lc on lc.prism_user_id = u.id
          left join token_profile_counts tpc on tpc.prism_user_id = u.id and tpc.slack_connection_id = lc.id
          left join latest_activity la on la.prism_user_id = u.id and la.slack_connection_id = lc.id`;
}

function profileSummarySelect(): string {
  return `select p.id, p.prism_user_id, p.slack_connection_id, p.name, p.intended_use, p.preset, p.capability_map,
                 p.expires_at, p.status, p.created_at,
                 t.created_at as developer_token_created_at,
                 t.expires_at as developer_token_expires_at,
                 t.last_used_at as developer_token_last_used_at,
                 t.revoked_at as developer_token_revoked_at,
                 overlap.overlap_expires_at
          from token_profiles p
          left join lateral (
            select created_at, expires_at, last_used_at, revoked_at, is_current
            from prism_developer_tokens
            where token_profile_id = p.id
            order by is_current desc, created_at desc
            limit 1
          ) t on true
          left join lateral (
            select max(rotation_overlap_expires_at) as overlap_expires_at
            from prism_developer_tokens
            where token_profile_id = p.id
              and is_current = false
              and revoked_at is null
              and rotation_overlap_expires_at > now()
          ) overlap on true
          where p.prism_user_id = $1 and p.slack_connection_id = $2 and p.status in ('active', 'revoked')
          order by p.created_at desc`;
}

function activitySummarySelect(): string {
  return `select id, prism_user_id, slack_connection_id, token_profile_id, token_profile_name,
                 slack_user_id, slack_team_id, slack_enterprise_id, activity_type, endpoint,
                 slack_method, action_category, surface, object_type, object_id, execution_mode,
                 status, error_class, http_status, request_id, upstream_called, occurred_at,
                 retention_expires_at, admin_actor_prism_user_id, admin_actor_slack_user_id,
                 admin_actor_slack_display_name, admin_reason
          from prism_activity_audit
          where prism_user_id = $1 and slack_connection_id = $2 and retention_expires_at > now()
          order by occurred_at desc`;
}

function toDirectoryRow(row: AdminUserRow): AdminUserDirectoryRow {
  return {
    prismUserId: row.prism_user_id,
    slackUser: { id: row.slack_user_id, displayName: row.slack_user_display_name },
    team: row.team_id ? { id: row.team_id, name: row.team_name } : null,
    enterprise: row.enterprise_id ? { id: row.enterprise_id, name: row.enterprise_name } : null,
    slackConnection: {
      id: row.slack_connection_id,
      status: row.slack_connection_status,
      lastErrorClass: row.slack_connection_last_error_class,
      updatedAt: toIso(row.slack_connection_updated_at)
    },
    tokenProfiles: {
      activeCount: toNumber(row.token_profile_active_count),
      revokedCount: toNumber(row.token_profile_revoked_count),
      activeDeveloperTokenCount: toNumber(row.active_developer_token_count),
      expiredDeveloperTokenCount: toNumber(row.expired_developer_token_count),
      revokedDeveloperTokenCount: toNumber(row.revoked_developer_token_count)
    },
    latestActivityAt: row.latest_activity_at ? toIso(row.latest_activity_at) : null
  };
}

function toTokenProfileSummary(row: TokenProfileAdminRow): TokenProfileSummary {
  return {
    id: row.id,
    name: row.name,
    intendedUse: row.intended_use,
    preset: row.preset,
    executionIdentity: row.capability_map.executionIdentity,
    capabilities: { ...row.capability_map.actions },
    expiresAt: row.expires_at ? toIso(row.expires_at) : null,
    status: row.status === "revoked" ? "revoked" : "active",
    createdAt: toIso(row.created_at),
    developerToken: {
      status: developerTokenStatus(row),
      createdAt: row.developer_token_created_at ? toIso(row.developer_token_created_at) : null,
      expiresAt: row.developer_token_expires_at ? toIso(row.developer_token_expires_at) : null,
      lastUsedAt: row.developer_token_last_used_at ? toIso(row.developer_token_last_used_at) : null,
      revokedAt: row.developer_token_revoked_at ? toIso(row.developer_token_revoked_at) : null,
      overlapExpiresAt: row.overlap_expires_at ? toIso(row.overlap_expires_at) : null
    }
  };
}

function toActivitySummary(row: ActivityAdminRow): ActivityAuditSummary {
  return {
    id: row.id,
    occurredAt: toIso(row.occurred_at),
    activityType: row.activity_type,
    status: row.status,
    tokenProfileId: row.token_profile_id,
    tokenProfileName: row.token_profile_name,
    slackMethod: row.slack_method,
    actionCategory: row.action_category,
    surface: row.surface,
    objectType: row.object_type,
    objectId: row.object_id,
    executionMode: row.execution_mode,
    errorClass: row.error_class,
    httpStatus: row.http_status,
    upstreamCalled: row.upstream_called,
    requestId: row.request_id,
    adminActorPrismUserId: row.admin_actor_prism_user_id ?? null,
    adminActorSlackUserId: row.admin_actor_slack_user_id ?? null,
    adminActorSlackDisplayName: row.admin_actor_slack_display_name ?? null,
    adminReason: row.admin_reason ?? null
  };
}

function developerTokenStatus(row: TokenProfileAdminRow): NonNullable<TokenProfileSummary["developerToken"]>["status"] {
  if (!row.developer_token_created_at) return "missing";
  if (row.developer_token_revoked_at) return "revoked";
  if (row.developer_token_expires_at && new Date(row.developer_token_expires_at) <= new Date()) return "expired";
  return "active";
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function boundedLimit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

type AdminUserRow = {
  prism_user_id: string;
  slack_user_id: string;
  slack_user_display_name: string | null;
  team_id: string | null;
  team_name: string | null;
  enterprise_id: string | null;
  enterprise_name: string | null;
  slack_connection_id: string;
  slack_connection_status: "healthy" | "reauth_required";
  slack_connection_last_error_class: string | null;
  slack_connection_updated_at: Date | string;
  token_profile_active_count: number | string;
  token_profile_revoked_count: number | string;
  active_developer_token_count: number | string;
  expired_developer_token_count: number | string;
  revoked_developer_token_count: number | string;
  latest_activity_at: Date | string | null;
};

type TokenProfileAdminRow = {
  id: string;
  prism_user_id: string;
  slack_connection_id: string;
  name: string;
  intended_use: string;
  preset: TokenProfilePreset;
  capability_map: CapabilityMap & { executionIdentity: ExecutionIdentity };
  expires_at: Date | string | null;
  status: "active" | "bootstrap" | "revoked";
  created_at: Date | string;
  developer_token_created_at: Date | string | null;
  developer_token_expires_at: Date | string | null;
  developer_token_last_used_at: Date | string | null;
  developer_token_revoked_at: Date | string | null;
  overlap_expires_at: Date | string | null;
};

type ActivityAdminRow = {
  id: string;
  prism_user_id: string | null;
  slack_connection_id: string | null;
  token_profile_id: string | null;
  token_profile_name: string | null;
  slack_user_id: string | null;
  slack_team_id: string | null;
  slack_enterprise_id: string | null;
  activity_type: ActivityAuditSummary["activityType"];
  endpoint: string | null;
  slack_method: string | null;
  action_category: string | null;
  surface: string | null;
  object_type: string | null;
  object_id: string | null;
  execution_mode: string | null;
  status: ActivityAuditSummary["status"];
  error_class: string | null;
  http_status: number | null;
  request_id: string | null;
  upstream_called: boolean;
  occurred_at: Date | string;
  retention_expires_at: Date | string;
  admin_actor_prism_user_id?: string | null;
  admin_actor_slack_user_id?: string | null;
  admin_actor_slack_display_name?: string | null;
  admin_reason?: string | null;
};
