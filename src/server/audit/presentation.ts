import type { ActivityAuditRecord } from "./activity";

export type ActivityAuditSummary = {
  id: string;
  occurredAt: string;
  activityType: ActivityAuditRecord["activityType"];
  status: ActivityAuditRecord["status"];
  tokenProfileId: string | null;
  tokenProfileName: string | null;
  slackMethod: string | null;
  actionCategory: string | null;
  surface: string | null;
  objectType: string | null;
  objectId: string | null;
  executionMode: string | null;
  errorClass: string | null;
  httpStatus: number | null;
  upstreamCalled: boolean;
  requestId: string | null;
  adminActorPrismUserId: string | null;
  adminActorSlackUserId: string | null;
  adminActorSlackDisplayName: string | null;
  adminReason: string | null;
};

export function toActivityAuditSummary(record: ActivityAuditRecord): ActivityAuditSummary {
  return {
    id: record.id,
    occurredAt: record.occurredAt.toISOString(),
    activityType: record.activityType,
    status: record.status,
    tokenProfileId: record.tokenProfileId,
    tokenProfileName: record.tokenProfileName,
    slackMethod: record.slackMethod,
    actionCategory: record.actionCategory,
    surface: record.surface,
    objectType: record.objectType,
    objectId: record.objectId,
    executionMode: record.executionMode,
    errorClass: record.errorClass,
    httpStatus: record.httpStatus,
    upstreamCalled: record.upstreamCalled,
    requestId: record.requestId,
    adminActorPrismUserId: record.adminActorPrismUserId,
    adminActorSlackUserId: record.adminActorSlackUserId,
    adminActorSlackDisplayName: record.adminActorSlackDisplayName,
    adminReason: record.adminReason
  };
}
