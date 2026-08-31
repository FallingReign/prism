import { describe, expect, it, vi } from "vitest";

import { createRemoteCodexSlackService } from "./internal-slack-service";

describe("remote Codex internal Slack service", () => {
  it("reuses exact Prism credential custody, rate limiting, Web API client, and metadata-only pre-upstream audit", async () => {
    const sequence: string[] = [];
    const auditRecord = { id: "audit_1" } as never;
    const service = createRemoteCodexSlackService({
      rateLimiter: vi.fn(async () => {
        sequence.push("rate");
        return { kind: "allowed" } as const;
      }),
      credentialProvider: {
        getAccessToken: vi.fn(async (input) => {
          expect(input).toEqual({ connectionId: "connection-owner", kind: "bot" });
          sequence.push("credential");
          return { kind: "available", accessToken: "slack-token-canary" } as const;
        })
      },
      auditStore: {
        recordActivity: vi.fn(async (input) => {
          expect(input).not.toHaveProperty("payload");
          expect(JSON.stringify(input)).not.toContain("Home view content canary");
          expect(input).toMatchObject({
            prismUserId: "owner_1",
            slackConnectionId: "connection-owner",
            activityType: "remote_codex_app_home_published",
            status: "attempted",
            slackMethod: "views.publish",
            surface: "app_home",
            upstreamCalled: false
          });
          sequence.push("audit");
          return auditRecord;
        }),
        updateActivityOutcome: vi.fn(async () => {
          sequence.push("audit-outcome");
          return auditRecord;
        })
      },
      client: {
        requiresAccessToken: true,
        callMethod: vi.fn(async (input) => {
          expect(input).toMatchObject({ method: "views.publish", executionMode: "bot", accessToken: "slack-token-canary" });
          sequence.push("upstream");
          return { status: 200, body: { ok: true } };
        })
      }
    });

    await expect(
      service.call({
        ownerKey: "rc_install_1",
        connectionId: "connection-owner",
        prismUserId: "owner_1",
        slackUserId: "U123",
        slackTeamId: "T123",
        method: "views.publish",
        payload: { user_id: "U123", view: { text: "Home view content canary" } },
        activityType: "remote_codex_app_home_published",
        surface: "app_home",
        objectType: "remote_codex_installation",
        objectId: "rc_install_1",
        requestId: "request_1"
      })
    ).resolves.toEqual({ kind: "ok", body: { ok: true } });
    expect(sequence).toEqual(["rate", "credential", "audit", "upstream", "audit-outcome"]);
  });

  it("does not fetch credentials or call Slack after a rate limit", async () => {
    const credentialProvider = { getAccessToken: vi.fn() };
    const client = { callMethod: vi.fn() };
    const auditStore = { recordActivity: vi.fn(async () => ({ id: "audit_limited" }) as never), updateActivityOutcome: vi.fn() };
    const service = createRemoteCodexSlackService({
      rateLimiter: async () => ({ kind: "limited" }),
      credentialProvider,
      client,
      auditStore
    });

    await expect(
      service.call({
        ownerKey: "rc_install_1",
        connectionId: "connection-owner",
        prismUserId: "owner_1",
        slackUserId: "U123",
        slackTeamId: "T123",
        method: "views.publish",
        payload: {},
        activityType: "remote_codex_app_home_published",
        surface: "runner",
        requestId: "request_1"
      })
    ).resolves.toEqual({ kind: "unavailable", error: "rate_limited" });
    expect(credentialProvider.getAccessToken).not.toHaveBeenCalled();
    expect(client.callMethod).not.toHaveBeenCalled();
    expect(auditStore.recordActivity).toHaveBeenCalledWith(expect.objectContaining({ status: "rate_limited", upstreamCalled: false, surface: "runner" }));
  });
});
