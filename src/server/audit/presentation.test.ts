import { describe, expect, it } from "vitest";

import { toActivityAuditSummary } from "./presentation";
import type { ActivityAuditRecord } from "./activity";

describe("activity audit presentation", () => {
  it("includes admin actor and reason metadata without replacing target identity", () => {
    const summary = toActivityAuditSummary({
      id: "audit_1",
      prismUserId: "target_user",
      slackConnectionId: "conn_1",
      tokenProfileId: "profile_1",
      tokenProfileName: "Target profile",
      slackUserId: "U_TARGET",
      slackTeamId: "T_TARGET",
      slackEnterpriseId: null,
      activityType: "admin_token_profile_deleted",
      endpoint: "/v1/prism/admin/users/target_user/token-profiles/profile_1",
      slackMethod: null,
      actionCategory: null,
      surface: null,
      objectType: null,
      objectId: null,
      executionMode: null,
      status: "deleted",
      errorClass: null,
      httpStatus: 200,
      requestId: "req_1",
      upstreamCalled: false,
      adminActorPrismUserId: "admin_user",
      adminActorSlackUserId: "U_ADMIN",
      adminActorSlackDisplayName: "Ada Admin",
      adminReason: "Cleanup after security review",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      retentionExpiresAt: new Date("2026-04-01T00:00:00.000Z")
    } satisfies ActivityAuditRecord);

    expect(summary).toMatchObject({
      activityType: "admin_token_profile_deleted",
      tokenProfileId: "profile_1",
      adminActorSlackUserId: "U_ADMIN",
      adminActorSlackDisplayName: "Ada Admin",
      adminReason: "Cleanup after security review"
    });
    expect(JSON.stringify(summary)).not.toMatch(/prism_dev_|xox[bp]-|access_token|refresh_token|client_secret|token_hash|pepper/i);
  });
});
