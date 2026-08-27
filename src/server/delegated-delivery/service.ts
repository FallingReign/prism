import "server-only";

import { createHmac, randomBytes, randomUUID } from "node:crypto";

import type { DelegatedDeliveryConfig } from "../config";
import type { CredentialCipher } from "../credentials/encryption";
import { hashSecret } from "../slack/oauth-flow";
import {
  verifyDelegatedClientProof,
  verifyDelegatedExchangeDpop,
  type RegisteredDelegationJwk
} from "./proof";
import type { DelegatedDeliveryStore } from "./store";
import {
  DelegatedDeliveryStoreError,
  type DelegatedConsentPreview,
  type DelegatedErrorDecision,
  type DelegatedSlackPayload,
  type DelegationRequestRecord,
  type DelegatedTokenResponse
} from "./types";
import {
  sha256Base64Url,
  sha256Hex,
  validateDelegatedTokenForm,
  validateDelegationRequestJson
} from "./validation";

type EnabledConfig = Extract<DelegatedDeliveryConfig, { enabled: true }>;
type RandomBytes = (size: number) => Buffer;

export type DelegatedRequestDecision =
  | {
      kind: "success";
      status: 201;
      body: { request_id: string; approval_url: string; approval_expires_at: string };
    }
  | DelegatedErrorDecision;

export type DelegatedConsentDecision =
  | { kind: "preview"; preview: DelegatedConsentPreview }
  | { kind: "redirect"; location: string }
  | DelegatedErrorDecision;

export type DelegatedBrowserMutationDecision =
  | { kind: "redirect"; location: string }
  | DelegatedErrorDecision;

export async function createDelegationRequest(input: {
  rawBody: string;
  clientProof: string | null;
  sourceIdentifier: string;
  store: DelegatedDeliveryStore;
  cipher: CredentialCipher;
  config: DelegatedDeliveryConfig;
  now?: Date;
  random?: RandomBytes;
  randomId?: () => string;
}): Promise<DelegatedRequestDecision> {
  if (!input.config.enabled) return disabled();
  const config = input.config;
  const now = input.now ?? new Date();
  const validation = validateDelegationRequestJson({
    rawBody: input.rawBody,
    options: validationOptions(config),
    now
  });
  if (validation.kind !== "valid") return badRequest();
  const endpoint = `${config.issuer}/v1/prism/delegations/slack-message/requests`;
  const proof = await verifyDelegatedClientProof({
    proof: input.clientProof,
    registeredJwks: config.clientJwks as RegisteredDelegationJwk[],
    clientId: config.clientId,
    expectedHtu: endpoint,
    method: "POST",
    rawBody: input.rawBody,
    now,
    clockSkewSeconds: config.limits.proofClockSkewSeconds,
    proofLifetimeSeconds: config.limits.proofLifetimeSeconds
  });
  if (proof.kind !== "valid") return { kind: "error", status: 401, error: "invalid_client_proof" };

  const random = input.random ?? randomBytes;
  const requestId = input.randomId?.() ?? `ddr_${randomUUID()}`;
  const approvalHandle = random(32).toString("base64url");
  const request = validation.request;
  try {
    const [payloadEnvelope, returnStateEnvelope, approvalHandleEnvelope] = await Promise.all([
      input.cipher.encrypt(request.canonicalPayload, payloadAad(requestId)),
      input.cipher.encrypt(request.returnState, stateAad(requestId)),
      input.cipher.encrypt(approvalHandle, approvalHandleAad(requestId))
    ]);
    const stored = await input.store.createRequest({
      requestId,
      approvalHandleHash: hashSecret(approvalHandle),
      approvalHandleEnvelope,
      sourceIdentifier: input.sourceIdentifier,
      request,
      payloadEnvelope,
      returnStateEnvelope,
      approvalExpiresAt: new Date(now.getTime() + config.limits.approvalTtlMs),
      proofReplay: proof.replay,
      limits: config.limits,
      now
    });
    const persistedHandle = stored.kind === "created"
      ? approvalHandle
      : await input.cipher.decrypt(stored.approvalHandleEnvelope, approvalHandleAad(stored.request.id));
    if (!/^[A-Za-z0-9_-]{43}$/.test(persistedHandle)) throw new Error("invalid-approval-handle-envelope");
    const approvalUrl = new URL("/delegations/slack-message/authorize", config.issuer);
    approvalUrl.searchParams.set("request", persistedHandle);
    return {
      kind: "success",
      status: 201,
      body: {
        request_id: stored.request.id,
        approval_url: approvalUrl.toString(),
        approval_expires_at: stored.request.approvalExpiresAt.toISOString()
      }
    };
  } catch (error) {
    return mapStoreError(error, "invalid_client_proof");
  }
}

export async function resolveDelegationConsent(input: {
  handle: string | null;
  sessionToken?: string;
  store: DelegatedDeliveryStore;
  cipher: CredentialCipher;
  config: DelegatedDeliveryConfig;
  now?: Date;
}): Promise<DelegatedConsentDecision> {
  if (!input.config.enabled) return disabled();
  if (!input.handle || !/^[A-Za-z0-9_-]{43}$/.test(input.handle)) return { kind: "error", status: 404, error: "not_found" };
  const now = input.now ?? new Date();
  try {
    const lookup = await input.store.loadConsent({
      handleHash: hashSecret(input.handle),
      sessionTokenHash: input.sessionToken ? hashSecret(input.sessionToken) : null,
      now
    });
    if (lookup.kind === "not_found") return { kind: "error", status: 404, error: "not_found" };
    if (lookup.kind === "expired") return { kind: "error", status: 410, error: "invalid_grant" };
    if (lookup.kind === "policy_denied") return { kind: "error", status: 403, error: "policy_denied" };
    if (lookup.kind === "login_required") {
      if (!lookup.requestId) return { kind: "error", status: 404, error: "not_found" };
      const start = new URL("/v1/slack/oauth/start", input.config.issuer);
      start.searchParams.set("delegation_request", lookup.requestId);
      return { kind: "redirect", location: start.toString() };
    }
    const plaintext = await input.cipher.decrypt(lookup.request.payloadEnvelope, payloadAad(lookup.request.id));
    const payload = parseStoredPayload(plaintext);
    if (sha256Hex(plaintext) !== lookup.request.payloadSha256) throw new Error("delegated-payload-hash-mismatch");
    return {
      kind: "preview",
      preview: {
        requestId: lookup.request.id,
        externalJobId: lookup.request.externalJobId,
        revision: lookup.request.revision,
        payload,
        payloadSha256: lookup.request.payloadSha256,
        channelId: lookup.request.channelId,
        notBefore: lookup.request.notBefore,
        deliveryExpiresAt: lookup.request.deliveryExpiresAt,
        approvalExpiresAt: lookup.request.approvalExpiresAt,
        identity: lookup.identity
      }
    };
  } catch (error) {
    return mapStoreError(error, "invalid_grant");
  }
}

export async function createDelegationOAuthResume(input: {
  requestId: string;
  store: DelegatedDeliveryStore;
  config: DelegatedDeliveryConfig;
  now?: Date;
  random?: RandomBytes;
}): Promise<DelegatedConsentDecision> {
  if (!input.config.enabled) return disabled();
  if (!validRequestId(input.requestId)) return { kind: "error", status: 404, error: "not_found" };
  const handle = (input.random ?? randomBytes)(32).toString("base64url");
  const saved = await input.store.saveOAuthResumeHandle({
    requestId: input.requestId,
    handleHash: hashSecret(handle),
    now: input.now ?? new Date()
  });
  if (!saved) return { kind: "error", status: 410, error: "invalid_grant" };
  const url = new URL("/delegations/slack-message/authorize", input.config.issuer);
  url.searchParams.set("request", handle);
  return { kind: "redirect", location: url.toString() };
}

export async function approveDelegationRequest(input: {
  requestId: string;
  sessionToken?: string;
  store: DelegatedDeliveryStore;
  cipher: CredentialCipher;
  config: DelegatedDeliveryConfig;
  now?: Date;
  random?: RandomBytes;
}): Promise<DelegatedBrowserMutationDecision> {
  if (!input.config.enabled) return disabled();
  if (!validRequestId(input.requestId)) return { kind: "error", status: 404, error: "not_found" };
  const now = input.now ?? new Date();
  const code = (input.random ?? randomBytes)(32).toString("base64url");
  try {
    const approved = await input.store.approveRequest({
      requestId: input.requestId,
      sessionTokenHash: input.sessionToken ? hashSecret(input.sessionToken) : null,
      codeHash: hashSecret(code),
      codeExpiresAt: new Date(now.getTime() + input.config.limits.authorizationCodeTtlMs),
      now
    });
    if (!approved) return { kind: "error", status: 404, error: "not_found" };
    const state = await decryptReturnState(input.cipher, approved.request);
    const callback = new URL(approved.request.callbackUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    return { kind: "redirect", location: callback.toString() };
  } catch (error) {
    return mapStoreError(error, "invalid_grant");
  }
}

export async function denyDelegationRequest(input: {
  requestId: string;
  sessionToken?: string;
  store: DelegatedDeliveryStore;
  cipher: CredentialCipher;
  config: DelegatedDeliveryConfig;
  now?: Date;
}): Promise<DelegatedBrowserMutationDecision> {
  if (!input.config.enabled) return disabled();
  if (!validRequestId(input.requestId)) return { kind: "error", status: 404, error: "not_found" };
  try {
    const denied = await input.store.denyRequest({
      requestId: input.requestId,
      sessionTokenHash: input.sessionToken ? hashSecret(input.sessionToken) : null,
      now: input.now ?? new Date()
    });
    if (!denied) return { kind: "error", status: 404, error: "not_found" };
    return denialRedirect(input.cipher, denied);
  } catch (error) {
    return mapStoreError(error, "invalid_grant");
  }
}

export async function denyDelegationAfterOAuth(input: {
  requestId: string;
  store: DelegatedDeliveryStore;
  cipher: CredentialCipher;
  config: DelegatedDeliveryConfig;
  now?: Date;
}): Promise<DelegatedBrowserMutationDecision> {
  if (!input.config.enabled) return disabled();
  if (!validRequestId(input.requestId)) return { kind: "error", status: 404, error: "not_found" };
  try {
    const denied = await input.store.denyRequestAfterOAuth({ requestId: input.requestId, now: input.now ?? new Date() });
    if (!denied) return { kind: "error", status: 404, error: "not_found" };
    return denialRedirect(input.cipher, denied);
  } catch (error) {
    return mapStoreError(error, "invalid_grant");
  }
}

export async function exchangeDelegatedAuthorizationCode(input: {
  params: URLSearchParams;
  dpopProof: string | null;
  store: DelegatedDeliveryStore;
  config: DelegatedDeliveryConfig;
  now?: Date;
  random?: RandomBytes;
  randomId?: () => string;
}): Promise<{ kind: "success"; body: DelegatedTokenResponse } | DelegatedErrorDecision> {
  if (!input.config.enabled) return disabled();
  const config = input.config;
  const validation = validateDelegatedTokenForm(input.params, validationOptions(config));
  if (validation.kind !== "valid") return badRequest();
  const now = input.now ?? new Date();
  const request = validation.request;
  const codeHash = hashSecret(request.code);
  try {
    const binding = await input.store.loadCodeBinding({
      codeHash,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      now
    });
    if (!binding) return { kind: "error", status: 400, error: "invalid_grant" };
    if (binding.kind === "expired") return { kind: "error", status: 410, error: "invalid_grant" };
    const dpop = await verifyDelegatedExchangeDpop({
      proof: input.dpopProof,
      expectedJkt: binding.dpopJkt,
      expectedHtu: `${config.issuer}/v1/prism/delegations/slack-message/token`,
      now,
      clockSkewSeconds: config.limits.proofClockSkewSeconds,
      proofLifetimeSeconds: config.limits.proofLifetimeSeconds
    });
    if (dpop.kind !== "valid") return { kind: "error", status: 401, error: "invalid_dpop_proof" };
    const grant = `prism_grant_${(input.random ?? randomBytes)(32).toString("base64url")}`;
    const exchanged = await input.store.exchangeCodeForGrant({
      codeHash,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: sha256Base64Url(Buffer.from(request.codeVerifier, "ascii")),
      proofReplay: dpop.replay,
      grantId: input.randomId?.() ?? `ddg_${randomUUID()}`,
      grantHash: createHmac("sha256", config.grantPepper).update(grant).digest("hex"),
      pepperId: config.grantPepperId,
      statusRetentionMs: config.limits.statusRetentionMs,
      now
    });
    if (!exchanged) return { kind: "error", status: 400, error: "invalid_grant" };
    return {
      kind: "success",
      body: {
        grant_token: grant,
        token_type: "DPoP",
        expires_in: Math.max(0, Math.floor((exchanged.expiresAt.getTime() - now.getTime()) / 1000)),
        grant_id: exchanged.grantId,
        client_id: exchanged.clientId,
        external_job_id: exchanged.externalJobId,
        revision: exchanged.revision,
        prism_user_id: exchanged.prismUserId,
        slack_user_id: exchanged.slackUserId,
        team_id: exchanged.teamId,
        channel_id: exchanged.channelId,
        payload_sha256: exchanged.payloadSha256,
        not_before: exchanged.notBefore.toISOString(),
        expires_at: exchanged.expiresAt.toISOString()
      }
    };
  } catch (error) {
    return mapStoreError(error, "invalid_dpop_proof");
  }
}

async function denialRedirect(
  cipher: CredentialCipher,
  request: Pick<DelegationRequestRecord, "id" | "callbackUri" | "returnStateEnvelope">
): Promise<DelegatedBrowserMutationDecision> {
  const state = await decryptReturnState(cipher, request);
  const callback = new URL(request.callbackUri);
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("state", state);
  return { kind: "redirect", location: callback.toString() };
}

async function decryptReturnState(cipher: CredentialCipher, request: { id: string; returnStateEnvelope: Parameters<CredentialCipher["decrypt"]>[0] }): Promise<string> {
  const state = await cipher.decrypt(request.returnStateEnvelope, stateAad(request.id));
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error("delegated-return-state-invalid");
  return state;
}

function parseStoredPayload(value: string): DelegatedSlackPayload {
  const parsed = JSON.parse(value) as Partial<DelegatedSlackPayload>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.channel !== "string" ||
    typeof parsed.text !== "string" ||
    !Array.isArray(parsed.blocks) ||
    Object.keys(parsed).some((key) => !["channel", "text", "blocks"].includes(key))
  ) {
    throw new Error("delegated-payload-invalid");
  }
  return { channel: parsed.channel, text: parsed.text, blocks: parsed.blocks };
}

function validationOptions(config: EnabledConfig) {
  return {
    clientId: config.clientId,
    callbackUri: config.callbackUri,
    approvalTtlMs: config.limits.approvalTtlMs,
    maxScheduleHorizonMs: config.limits.maxScheduleHorizonMs,
    maxGrantWindowMs: config.limits.grantTtlMs
  };
}

function mapStoreError(
  error: unknown,
  proofError: "invalid_client_proof" | "invalid_dpop_proof" | "invalid_grant"
): DelegatedErrorDecision {
  if (!(error instanceof DelegatedDeliveryStoreError)) return { kind: "error", status: 500, error: "server_error" };
  switch (error.code) {
    case "proof_replay": return { kind: "error", status: 401, error: proofError };
    case "rate_limited": return { kind: "error", status: 429, error: "rate_limited", retryAfterSeconds: error.retryAfterSeconds };
    case "idempotency_conflict": return { kind: "error", status: 409, error: "idempotency_conflict" };
    case "lifecycle_conflict": return { kind: "error", status: 409, error: "lifecycle_conflict" };
    case "not_found": return { kind: "error", status: 404, error: "not_found" };
    case "not_yet_valid": return { kind: "error", status: 409, error: "not_yet_valid" };
    case "policy_denied": return { kind: "error", status: 403, error: "policy_denied" };
    case "expired": return { kind: "error", status: 410, error: "invalid_grant" };
  }
}

function validRequestId(value: string): boolean {
  return /^ddr_[A-Za-z0-9-]{16,64}$/.test(value);
}

function payloadAad(requestId: string): string { return `playtest-delivery:${requestId}:payload`; }
function stateAad(requestId: string): string { return `playtest-delivery:${requestId}:state`; }
function approvalHandleAad(requestId: string): string { return `playtest-delivery:${requestId}:approval-handle`; }
function disabled(): DelegatedErrorDecision { return { kind: "error", status: 404, error: "feature_disabled" }; }
function badRequest(): DelegatedErrorDecision { return { kind: "error", status: 400, error: "invalid_request" }; }
