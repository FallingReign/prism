import "server-only";

import { createHmac, randomUUID } from "node:crypto";

import type { DelegatedDeliveryConfig } from "../config";
import type { CredentialCipher } from "../credentials/encryption";
import type { SlackForwardingCredentialProvider } from "../slack/forwarding-credentials";
import type { SlackWebApiClient } from "../slack/web-api-client";
import { verifyDelegatedExecutionDpop } from "./proof";
import type { DelegatedDeliveryStore } from "./store";
import {
  DelegatedDeliveryStoreError,
  type DelegatedErrorDecision,
  type DelegatedExecutionResponse,
  type DelegatedSlackPayload
} from "./types";
import { sha256Hex } from "./validation";

export async function executeDelegatedSlackMessage(input: {
  grantToken: string | null;
  dpopProof: string | null;
  store: DelegatedDeliveryStore;
  cipher: CredentialCipher;
  credentialProvider: SlackForwardingCredentialProvider;
  slackClient: SlackWebApiClient;
  config: DelegatedDeliveryConfig;
  now?: Date;
  randomId?: () => string;
}): Promise<{ kind: "success"; body: DelegatedExecutionResponse } | DelegatedErrorDecision> {
  if (!input.config.enabled) return { kind: "error", status: 404, error: "feature_disabled" };
  if (!input.grantToken || !/^prism_grant_[A-Za-z0-9_-]{43}$/.test(input.grantToken)) {
    return { kind: "error", status: 401, error: "invalid_grant" };
  }
  const config = input.config;
  const now = input.now ?? new Date();
  const grantHash = createHmac("sha256", config.grantPepper).update(input.grantToken).digest("hex");
  const existing = await input.store.loadGrantExecutionBinding({ grantHash, pepperId: config.grantPepperId });
  if (!existing) return { kind: "error", status: 401, error: "invalid_grant" };
  const proof = await verifyDelegatedExecutionDpop({
    proof: input.dpopProof,
    grantToken: input.grantToken,
    expectedJkt: existing.dpopJkt,
    expectedHtu: `${config.issuer}/v1/prism/delegations/slack-message/execute`,
    now,
    clockSkewSeconds: config.limits.proofClockSkewSeconds,
    proofLifetimeSeconds: config.limits.proofLifetimeSeconds
  });
  if (proof.kind !== "valid") return { kind: "error", status: 401, error: "invalid_dpop_proof" };

  const leaseId = input.randomId?.() ?? `ddl_${randomUUID()}`;
  let binding;
  try {
    binding = await input.store.claimGrantExecution({
      grantHash,
      pepperId: config.grantPepperId,
      proofReplay: proof.replay,
      leaseId,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      now
    });
  } catch (error) {
    return mapStoreError(error);
  }
  if (binding.state !== "executing") return { kind: "success", body: responseFor(binding) };

  let payload: DelegatedSlackPayload;
  try {
    const canonical = await input.cipher.decrypt(binding.payloadEnvelope, `playtest-delivery:${binding.requestId}:payload`);
    if (sha256Hex(canonical) !== binding.payloadSha256) throw new Error("payload_hash_mismatch");
    const parsed = JSON.parse(canonical) as Partial<DelegatedSlackPayload>;
    if (
      !parsed || typeof parsed !== "object" || parsed.channel !== binding.channelId ||
      typeof parsed.text !== "string" || !Array.isArray(parsed.blocks) ||
      Object.keys(parsed).some((key) => !["channel", "text", "blocks"].includes(key))
    ) throw new Error("payload_invalid");
    payload = { channel: parsed.channel, text: parsed.text, blocks: parsed.blocks };
  } catch {
    const terminal = await input.store.finishGrantExecution({
      grantId: binding.grantId, leaseId, state: "failed", errorCode: "payload_integrity_failed",
      upstreamCalled: false, now
    });
    return { kind: "success", body: responseFor(terminal) };
  }

  const credential = await input.credentialProvider.getAccessToken({
    connectionId: binding.slackConnectionId,
    kind: "user"
  });
  if (credential.kind === "unavailable") {
    const terminal = await input.store.finishGrantExecution({
      grantId: binding.grantId, leaseId, state: "failed", errorCode: credential.errorClass,
      upstreamCalled: false, now
    });
    return { kind: "success", body: responseFor(terminal) };
  }

  await input.store.markGrantUpstreamCalled({ grantId: binding.grantId, leaseId, now: new Date() });
  const upstream = await input.slackClient.callMethod({
    method: "chat.postMessage",
    httpMethod: "POST",
    payloadEncoding: "json",
    payload,
    executionMode: "user",
    accessToken: credential.accessToken
  });
  const slack = parseSlackResult(upstream.body, binding.channelId);
  const requestId = readHeader(upstream.headers, "x-slack-req-id");
  // Any 5xx may have happened after Slack accepted the request. Never retry
  // automatically because that could duplicate an approved announcement.
  const unknown = upstream.status >= 500;
  const terminal = await input.store.finishGrantExecution({
    grantId: binding.grantId,
    leaseId,
    state: slack.ok ? "sent" : unknown ? "outcome_unknown" : "failed",
    slackRequestId: requestId,
    slackTs: slack.ok ? slack.ts : null,
    errorCode: slack.ok ? null : slack.error,
    httpStatus: upstream.status,
    upstreamCalled: true,
    now: new Date()
  });
  return { kind: "success", body: responseFor(terminal) };
}

function responseFor(binding: Awaited<ReturnType<DelegatedDeliveryStore["claimGrantExecution"]>>): DelegatedExecutionResponse {
  const state = binding.state === "sent" ? "sent" : binding.state === "outcome_unknown" ? "outcome_unknown" : "failed";
  return {
    state,
    grant_id: binding.grantId,
    external_job_id: binding.externalJobId,
    revision: binding.revision,
    prism_user_id: binding.prismUserId,
    slack_user_id: binding.slackUserId,
    team_id: binding.teamId,
    channel_id: binding.channelId,
    payload_sha256: binding.payloadSha256,
    slack_ts: binding.slackTs,
    error: binding.lastErrorCode
  };
}

function parseSlackResult(value: unknown, channelId: string): { ok: true; ts: string } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "slack_bad_response" };
  const body = value as Record<string, unknown>;
  if (body.ok === true && body.channel === channelId && typeof body.ts === "string" && /^\d+\.\d+$/.test(body.ts)) {
    return { ok: true, ts: body.ts };
  }
  return { ok: false, error: typeof body.error === "string" && /^[a-z0-9_]+$/.test(body.error) ? body.error : "slack_error" };
}

function readHeader(headers: Headers | Record<string, string | undefined> | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}

function mapStoreError(error: unknown): DelegatedErrorDecision {
  if (!(error instanceof DelegatedDeliveryStoreError)) return { kind: "error", status: 500, error: "server_error" };
  if (error.code === "proof_replay") return { kind: "error", status: 401, error: "invalid_dpop_proof" };
  if (error.code === "not_found") return { kind: "error", status: 401, error: "invalid_grant" };
  if (error.code === "expired") return { kind: "error", status: 410, error: "invalid_grant" };
  if (error.code === "not_yet_valid") return { kind: "error", status: 409, error: "not_yet_valid" };
  if (error.code === "policy_denied") return { kind: "error", status: 403, error: "policy_denied" };
  return { kind: "error", status: 409, error: "lifecycle_conflict" };
}
