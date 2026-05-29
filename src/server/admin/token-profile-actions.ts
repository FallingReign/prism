import "server-only";

import type { TokenProfileSummary } from "../../../app/token-profile-summary";
import type { TokenProfileMetadata, TokenProfileStore } from "../token-profiles/service";
import type { AdminAuthorizationDecision, AdminScope } from "./authorization";
import { getAdminUserDetail, type AdminUserDirectoryStore } from "./user-directory";

const ADMIN_REASON_MAX_LENGTH = 240;

type AdminTokenProfileActionInput = {
  decision: AdminAuthorizationDecision;
  directoryStore: AdminUserDirectoryStore;
  tokenStore: TokenProfileStore;
  userId: string;
  profileId: string;
  reason: string | undefined;
  confirmation: string | undefined;
  audit: { endpoint: string; requestId: string };
  now?: Date;
};

type AdminTokenProfileActionResult =
  | { kind: "revoked"; profile: TokenProfileMetadata; scope: AdminScope }
  | { kind: "deleted"; profile: TokenProfileMetadata; scope: AdminScope }
  | { kind: "unauthenticated" | "forbidden" | "not_found" | "conflict" }
  | { kind: "validation_error"; message: string };

export async function revokeAdminTokenProfile(input: AdminTokenProfileActionInput): Promise<AdminTokenProfileActionResult> {
  const context = await resolveAdminActionContext(input, "REVOKE");
  if (context.kind !== "ready") return context;
  if (context.profile.status === "revoked") return { kind: "not_found" };

  const result = await input.tokenStore.revokeProfileDeveloperTokens({
    prismUserId: context.prismUserId,
    slackConnectionId: context.slackConnectionId,
    profileId: input.profileId,
    now: input.now ?? new Date(),
    audit: {
      ...input.audit,
      activityType: "admin_token_profile_revoked",
      adminActorPrismUserId: context.admin.prismUserId,
      adminActorSlackUserId: context.admin.slackUserId,
      adminActorSlackDisplayName: context.admin.slackUserDisplayName,
      adminReason: context.reason
    }
  });
  if (result.kind === "not_found") return result;
  return { kind: "revoked", profile: result.profile, scope: context.scope };
}

export async function deleteAdminTokenProfile(input: AdminTokenProfileActionInput): Promise<AdminTokenProfileActionResult> {
  const context = await resolveAdminActionContext(input, "DELETE");
  if (context.kind !== "ready") return context;
  if (context.profile.status === "active" && context.profile.developerToken?.status === "active") return { kind: "conflict" };

  const result = await input.tokenStore.deleteInactiveProfile({
    prismUserId: context.prismUserId,
    slackConnectionId: context.slackConnectionId,
    profileId: input.profileId,
    now: input.now ?? new Date(),
    audit: {
      ...input.audit,
      activityType: "admin_token_profile_deleted",
      adminActorPrismUserId: context.admin.prismUserId,
      adminActorSlackUserId: context.admin.slackUserId,
      adminActorSlackDisplayName: context.admin.slackUserDisplayName,
      adminReason: context.reason
    }
  });
  if (result.kind !== "deleted") return result;
  return { kind: "deleted", profile: result.profile, scope: context.scope };
}

async function resolveAdminActionContext(
  input: AdminTokenProfileActionInput,
  expectedConfirmation: "REVOKE" | "DELETE"
): Promise<
  | {
      kind: "ready";
      admin: Extract<AdminAuthorizationDecision, { kind: "authorized" }>;
      scope: AdminScope;
      prismUserId: string;
      slackConnectionId: string;
      profile: TokenProfileSummary;
      reason: string;
    }
  | Exclude<AdminTokenProfileActionResult, { kind: "revoked" | "deleted" }>
> {
  if (input.decision.kind === "unauthenticated") return { kind: "unauthenticated" };
  if (input.decision.kind === "not_admin") return { kind: "forbidden" };

  const validation = validateAdminActionInput(input.reason, input.confirmation, expectedConfirmation);
  if (validation.kind === "validation_error") return validation;

  const detail = await getAdminUserDetail({
    decision: input.decision,
    store: input.directoryStore,
    userId: input.userId,
    profileLimit: 100,
    activityLimit: 1
  });
  if (detail.kind !== "detail") return { kind: detail.kind };

  const profile = detail.detail.profiles.find((candidate) => candidate.id === input.profileId);
  if (!profile) return { kind: "not_found" };

  return {
    kind: "ready",
    admin: input.decision,
    scope: detail.scope,
    prismUserId: detail.detail.user.prismUserId,
    slackConnectionId: detail.detail.user.slackConnection.id,
    profile,
    reason: validation.reason
  };
}

function validateAdminActionInput(
  reason: string | undefined,
  confirmation: string | undefined,
  expectedConfirmation: "REVOKE" | "DELETE"
): { kind: "valid"; reason: string } | { kind: "validation_error"; message: string } {
  if (confirmation !== expectedConfirmation) {
    return { kind: "validation_error", message: `Type ${expectedConfirmation} to confirm this admin action.` };
  }
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) return { kind: "validation_error", message: "Admin reason is required." };
  if (trimmed.length > ADMIN_REASON_MAX_LENGTH) {
    return { kind: "validation_error", message: `Admin reason must be ${ADMIN_REASON_MAX_LENGTH} characters or fewer.` };
  }
  return { kind: "valid", reason: trimmed };
}
