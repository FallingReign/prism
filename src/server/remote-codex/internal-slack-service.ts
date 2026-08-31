import "server-only";

import { createPostgresActivityAuditStore, type ActivityAuditStore } from "../audit/postgres-store";
import type { ActivityType } from "../audit/activity";
import { createConfiguredCredentialCipher } from "../credentials/factory";
import { database } from "../db";
import { createConfiguredSlackOAuthClient } from "../slack/app-configuration-factory";
import { createSlackForwardingCredentialProvider, type SlackForwardingCredentialProvider } from "../slack/forwarding-credentials";
import { createPostgresRefreshStore } from "../slack/postgres-store";
import { createDefaultSlackWebApiClient, type SlackWebApiClient } from "../slack/web-api-client";

export type RemoteCodexSlackRateLimiter = (input: {
  ownerKey: string;
  method: string;
}) => Promise<{ kind: "allowed" } | { kind: "limited" }>;

type RemoteCodexSlackCall = {
  ownerKey: string;
  connectionId: string;
  prismUserId: string;
  slackUserId: string;
  slackTeamId: string;
  method: string;
  payload: Record<string, unknown>;
  activityType: Extract<ActivityType, "remote_codex_app_home_published" | "remote_codex_binding_created" | "remote_codex_binding_status_updated">;
  surface: "app_home" | "runner" | "remote_codex_sync";
  objectType?: string;
  objectId?: string;
  requestId: string;
};

export function createRemoteCodexSlackService({
  rateLimiter,
  credentialProvider,
  auditStore,
  client,
  connectionStore
}: {
  rateLimiter: RemoteCodexSlackRateLimiter;
  credentialProvider: SlackForwardingCredentialProvider;
  auditStore: Pick<ActivityAuditStore, "recordActivity" | "updateActivityOutcome">;
  client: SlackWebApiClient;
  connectionStore?: { markConnectionReauthRequired(connectionId: string, errorClass: string): Promise<void> };
}) {
  return {
    async call(input: RemoteCodexSlackCall): Promise<{ kind: "ok"; body: unknown } | { kind: "unavailable"; error: string }> {
      const rate = await rateLimiter({ ownerKey: input.ownerKey, method: input.method });
      if (rate.kind === "limited") {
        await auditStore.recordActivity(auditInput(input, "rate_limited"));
        return { kind: "unavailable", error: "rate_limited" };
      }
      const credential = await credentialProvider.getAccessToken({ connectionId: input.connectionId, kind: "bot" });
      if (credential.kind !== "available") {
        await auditStore.recordActivity(auditInput(input, "identity_unavailable"));
        return { kind: "unavailable", error: credential.errorClass };
      }

      const audit = await auditStore.recordActivity(auditInput(input, "attempted"));
      const payload = "team_id" in input.payload
        ? input.payload
        : { ...input.payload, team_id: input.slackTeamId };
      const upstream = await client.callMethod({
        method: input.method,
        httpMethod: "POST",
        payloadEncoding: "json",
        payload,
        executionMode: "bot",
        accessToken: credential.accessToken
      });
      const slackError = readSlackError(upstream.body);
      if (slackError && isCredentialRejection(slackError)) {
        await connectionStore?.markConnectionReauthRequired(input.connectionId, slackError);
      }
      try {
        await auditStore.updateActivityOutcome(audit.id, {
          status: slackError ? "upstream_error" : "forwarded",
          errorClass: slackError,
          httpStatus: upstream.status,
          upstreamCalled: true
        });
      } catch {
        // The pre-upstream record already exists. Never log Slack payloads while reporting an update failure.
      }
      return slackError ? { kind: "unavailable", error: slackError } : { kind: "ok", body: upstream.body };
    }
  };
}

function auditInput(input: RemoteCodexSlackCall, status: "attempted" | "rate_limited" | "identity_unavailable") {
  return {
    prismUserId: input.prismUserId,
    slackConnectionId: input.connectionId,
    slackUserId: input.slackUserId,
    slackTeamId: input.slackTeamId,
    activityType: input.activityType,
    slackMethod: input.method,
    actionCategory: "remote_codex",
    surface: input.surface,
    objectType: input.objectType,
    objectId: input.objectId,
    executionMode: "bot",
    status,
    requestId: input.requestId,
    upstreamCalled: false
  } as const;
}

export async function createDefaultRemoteCodexSlackService(rateLimiter: RemoteCodexSlackRateLimiter) {
  const cipher = createConfiguredCredentialCipher();
  const connectionStore = createPostgresRefreshStore(database);
  return createRemoteCodexSlackService({
    rateLimiter,
    credentialProvider: createSlackForwardingCredentialProvider({
      store: connectionStore,
      cipher,
      slackOAuthClient: await createConfiguredSlackOAuthClient({ database })
    }),
    auditStore: createPostgresActivityAuditStore(database),
    client: createDefaultSlackWebApiClient(),
    connectionStore
  });
}

function isCredentialRejection(error: string): boolean {
  return error === "not_authed" || error === "invalid_auth" || error === "token_revoked" ||
    error === "token_expired" || error === "account_inactive";
}

function readSlackError(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("ok" in body) || body.ok !== false) return null;
  return "error" in body && typeof body.error === "string" ? body.error.slice(0, 120) : "slack_error";
}
