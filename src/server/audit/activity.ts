import { randomUUID } from "node:crypto";

export const ACTIVITY_AUDIT_DEFAULT_RETENTION_DAYS = 90;

export type ActivityType =
  | "slack_method"
  | "token_profile_created"
  | "token_profiles_listed"
  | "token_profile_revoked"
  | "token_profile_rotated"
  | "token_profile_policy_updated"
  | "token_profile_deleted"
  | "slack_connection_removed"
  | "global_token_profile_policy_updated"
  | "admin_token_profile_revoked"
  | "admin_token_profile_deleted";

export type ActivityStatus =
  | "attempted"
  | "forwarded"
  | "upstream_error"
  | "denied"
  | "unsupported"
  | "auth_failed"
  | "identity_unavailable"
  | "parse_error"
  | "rate_limited"
  | "created"
  | "listed"
  | "revoked"
  | "rotated"
  | "updated"
  | "deleted";

export type ActivityAuditInput = {
  prismUserId?: string | null;
  slackConnectionId?: string | null;
  tokenProfileId?: string | null;
  tokenProfileName?: string | null;
  slackUserId?: string | null;
  slackTeamId?: string | null;
  slackEnterpriseId?: string | null;
  activityType: ActivityType;
  endpoint?: string | null;
  slackMethod?: string | null;
  actionCategory?: string | null;
  surface?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  executionMode?: string | null;
  status: ActivityStatus;
  errorClass?: string | null;
  httpStatus?: number | null;
  requestId?: string | null;
  upstreamCalled?: boolean;
  adminActorPrismUserId?: string | null;
  adminActorSlackUserId?: string | null;
  adminActorSlackDisplayName?: string | null;
  adminReason?: string | null;
  occurredAt?: Date;
  retentionDays?: number;
  // Deliberately ignored. Tests pass canaries here to prove the public builder
  // never carries content or secret material into the persisted record shape.
  contentCanaries?: unknown;
};

export type ActivityAuditRecord = {
  id: string;
  prismUserId: string | null;
  slackConnectionId: string | null;
  tokenProfileId: string | null;
  tokenProfileName: string | null;
  slackUserId: string | null;
  slackTeamId: string | null;
  slackEnterpriseId: string | null;
  activityType: ActivityType;
  endpoint: string | null;
  slackMethod: string | null;
  actionCategory: string | null;
  surface: string | null;
  objectType: string | null;
  objectId: string | null;
  executionMode: string | null;
  status: ActivityStatus;
  errorClass: string | null;
  httpStatus: number | null;
  requestId: string | null;
  upstreamCalled: boolean;
  adminActorPrismUserId: string | null;
  adminActorSlackUserId: string | null;
  adminActorSlackDisplayName: string | null;
  adminReason: string | null;
  occurredAt: Date;
  retentionExpiresAt: Date;
};

export type SlackObjectMetadata = {
  objectType?: string;
  objectId?: string;
};

export function buildActivityAuditRecord(
  input: ActivityAuditInput,
  options: { now?: Date; randomId?: () => string } = {}
): ActivityAuditRecord {
  const occurredAt = input.occurredAt ?? options.now ?? new Date();
  const retentionDays = input.retentionDays ?? ACTIVITY_AUDIT_DEFAULT_RETENTION_DAYS;

  return {
    id: options.randomId?.() ?? randomUUID(),
    prismUserId: nullableText(input.prismUserId),
    slackConnectionId: nullableText(input.slackConnectionId),
    tokenProfileId: nullableText(input.tokenProfileId),
    tokenProfileName: truncate(nullableText(input.tokenProfileName), 120),
    slackUserId: nullableText(input.slackUserId),
    slackTeamId: nullableText(input.slackTeamId),
    slackEnterpriseId: nullableText(input.slackEnterpriseId),
    activityType: input.activityType,
    endpoint: truncate(nullableText(input.endpoint), 200),
    slackMethod: truncate(nullableText(input.slackMethod), 120),
    actionCategory: truncate(nullableText(input.actionCategory), 120),
    surface: truncate(nullableText(input.surface), 80),
    objectType: truncate(nullableText(input.objectType), 80),
    objectId: truncate(nullableText(input.objectId), 160),
    executionMode: truncate(nullableText(input.executionMode), 40),
    status: input.status,
    errorClass: truncate(nullableText(input.errorClass), 120),
    httpStatus: input.httpStatus ?? null,
    requestId: truncate(nullableText(input.requestId), 120),
    upstreamCalled: input.upstreamCalled ?? false,
    adminActorPrismUserId: truncate(nullableText(input.adminActorPrismUserId), 120),
    adminActorSlackUserId: truncate(nullableText(input.adminActorSlackUserId), 120),
    adminActorSlackDisplayName: truncate(nullableText(input.adminActorSlackDisplayName), 120),
    adminReason: truncate(nullableText(input.adminReason), 240),
    occurredAt,
    retentionExpiresAt: addDays(occurredAt, retentionDays)
  };
}

export function extractSlackObjectMetadata(method: string, payload: Record<string, unknown>): SlackObjectMetadata {
  if (method.startsWith("files.") && isSlackFileId(payload.file)) {
    return { objectType: "file", objectId: payload.file };
  }

  if (method.startsWith("users.") && isSlackUserId(payload.user)) {
    return { objectType: "user", objectId: payload.user };
  }

  if (method.startsWith("conversations.") && isSlackChannelId(payload.channel)) {
    return { objectType: "channel", objectId: payload.channel };
  }

  if ((method.startsWith("chat.") || method.startsWith("reactions.")) && isSlackChannelId(payload.channel)) {
    return { objectType: "channel", objectId: payload.channel };
  }

  return {};
}

export function auditRetentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRISM_AUDIT_RETENTION_DAYS;
  if (!raw) {
    return ACTIVITY_AUDIT_DEFAULT_RETENTION_DAYS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw new Error("PRISM_AUDIT_RETENTION_DAYS must be an integer between 1 and 3650");
  }
  return parsed;
}

function nullableText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSlackChannelId(value: unknown): value is string {
  return typeof value === "string" && /^[CGD][A-Z0-9]{2,}$/.test(value);
}

function isSlackFileId(value: unknown): value is string {
  return typeof value === "string" && /^F[A-Z0-9]{2,}$/.test(value);
}

function isSlackUserId(value: unknown): value is string {
  return typeof value === "string" && /^[UW][A-Z0-9]{2,}$/.test(value);
}

function truncate(value: string | null, maxLength: number): string | null {
  if (value === null || value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}
