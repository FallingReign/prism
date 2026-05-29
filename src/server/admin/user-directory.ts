import "server-only";

import type { ActivityAuditSummary } from "../audit/presentation";
import type { TokenProfileSummary } from "../../../app/token-profile-summary";
import type { AdminAuthorizationDecision, AdminScope } from "./authorization";

export type AdminSlackIdentitySummary = {
  id: string;
  displayName: string | null;
};

export type AdminSlackScopeSummary = {
  id: string;
  name: string | null;
};

export type AdminSlackConnectionSummary = {
  id: string;
  status: "healthy" | "reauth_required";
  lastErrorClass: string | null;
  updatedAt: string;
};

export type AdminTokenProfileCounts = {
  activeCount: number;
  revokedCount: number;
  activeDeveloperTokenCount: number;
  expiredDeveloperTokenCount: number;
  revokedDeveloperTokenCount: number;
};

export type AdminUserDirectoryRow = {
  prismUserId: string;
  slackUser: AdminSlackIdentitySummary;
  team: AdminSlackScopeSummary | null;
  enterprise: AdminSlackScopeSummary | null;
  slackConnection: AdminSlackConnectionSummary;
  tokenProfiles: AdminTokenProfileCounts;
  latestActivityAt: string | null;
};

export type AdminUserDetail = {
  user: AdminUserDirectoryRow;
  profiles: TokenProfileSummary[];
  activity: ActivityAuditSummary[];
};

export type AdminUserDirectoryStore = {
  listUsers(input: { scope: AdminScope; limit: number }): Promise<AdminUserDirectoryRow[]>;
  getUserDetail(input: { scope: AdminScope; userId: string; profileLimit: number; activityLimit: number }): Promise<AdminUserDetail | null>;
};

export async function listAdminUsers({
  decision,
  store,
  limit = 50
}: {
  decision: AdminAuthorizationDecision;
  store: AdminUserDirectoryStore;
  limit?: number;
}): Promise<{ kind: "users"; scope: AdminScope; users: AdminUserDirectoryRow[] } | { kind: "unauthenticated" } | { kind: "forbidden" }> {
  if (decision.kind === "unauthenticated") return { kind: "unauthenticated" };
  if (decision.kind === "not_admin") return { kind: "forbidden" };
  const boundedLimit = bound(limit, 1, 100);
  const users = await store.listUsers({ scope: decision.scope, limit: boundedLimit });
  return { kind: "users", scope: decision.scope, users: users.map(redactUserRow) };
}

export async function getAdminUserDetail({
  decision,
  store,
  userId,
  profileLimit = 50,
  activityLimit = 20
}: {
  decision: AdminAuthorizationDecision;
  store: AdminUserDirectoryStore;
  userId: string;
  profileLimit?: number;
  activityLimit?: number;
}): Promise<
  | { kind: "detail"; scope: AdminScope; detail: AdminUserDetail }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
> {
  if (decision.kind === "unauthenticated") return { kind: "unauthenticated" };
  if (decision.kind === "not_admin") return { kind: "forbidden" };
  const detail = await store.getUserDetail({
    scope: decision.scope,
    userId,
    profileLimit: bound(profileLimit, 1, 100),
    activityLimit: bound(activityLimit, 1, 50)
  });
  if (!detail) return { kind: "not_found" };
  return { kind: "detail", scope: decision.scope, detail: redactUserDetail(detail) };
}

export function redactSecretText(value: string): string {
  return value
    .replace(/prism_dev_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/xox[a-z]-[A-Za-z0-9-]+/gi, "[redacted]")
    .replace(/(?:access|refresh)[_-]?token|client[_-]?secret|token[_-]?hash|pepper|refresh[_-]?secret|authorization/gi, "[redacted]");
}

function redactUserDetail(detail: AdminUserDetail): AdminUserDetail {
  return {
    user: redactUserRow(detail.user),
    profiles: detail.profiles.map(redactProfile),
    activity: detail.activity.map(redactActivity)
  };
}

function redactUserRow(row: AdminUserDirectoryRow): AdminUserDirectoryRow {
  return {
    ...row,
    slackUser: redactIdentity(row.slackUser),
    team: row.team ? redactScope(row.team) : null,
    enterprise: row.enterprise ? redactScope(row.enterprise) : null,
    slackConnection: { ...row.slackConnection, lastErrorClass: redactOptional(row.slackConnection.lastErrorClass) }
  };
}

function redactProfile(profile: TokenProfileSummary): TokenProfileSummary {
  return {
    ...profile,
    name: redactSecretText(profile.name),
    intendedUse: redactSecretText(profile.intendedUse)
  };
}

function redactActivity(activity: ActivityAuditSummary): ActivityAuditSummary {
  return {
    ...activity,
    tokenProfileName: redactOptional(activity.tokenProfileName),
    slackMethod: redactOptional(activity.slackMethod),
    actionCategory: redactOptional(activity.actionCategory),
    surface: redactOptional(activity.surface),
    objectType: redactOptional(activity.objectType),
    objectId: redactOptional(activity.objectId),
    executionMode: redactOptional(activity.executionMode),
    errorClass: redactOptional(activity.errorClass),
    requestId: redactOptional(activity.requestId),
    adminActorPrismUserId: redactOptional(activity.adminActorPrismUserId),
    adminActorSlackUserId: redactOptional(activity.adminActorSlackUserId),
    adminActorSlackDisplayName: redactOptional(activity.adminActorSlackDisplayName),
    adminReason: redactOptional(activity.adminReason)
  };
}

function redactIdentity(identity: AdminSlackIdentitySummary): AdminSlackIdentitySummary {
  return { id: redactSecretText(identity.id), displayName: redactOptional(identity.displayName) };
}

function redactScope(scope: AdminSlackScopeSummary): AdminSlackScopeSummary {
  return { id: redactSecretText(scope.id), name: redactOptional(scope.name) };
}

function redactOptional(value: string | null): string | null {
  return value ? redactSecretText(value) : null;
}

function bound(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(Math.trunc(value), max));
}
