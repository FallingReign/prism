import "server-only";

import type { CredentialEnvelope } from "../credentials/encryption";

export const DELEGATED_CLIENT_PROOF_AUDIENCE = "urn:prism:delegated-slack-message:v1";
export const DELEGATED_GRANT_TYPE = "urn:prism:params:grant-type:delegated-slack-message";
export const DELEGATED_ACTION = "chat.postMessage";
export const DELEGATED_EXECUTION_MODE = "user";

export type DelegatedSlackPayload = {
  channel: string;
  text: string;
  blocks: unknown[];
};

export type DelegationRequestInput = {
  clientId: string;
  callbackUri: string;
  externalJobId: string;
  revision: number;
  idempotencyKey: string;
  expectedPrismUserId: string;
  teamId: string;
  channelId: string;
  action: typeof DELEGATED_ACTION;
  executionMode: typeof DELEGATED_EXECUTION_MODE;
  payload: DelegatedSlackPayload;
  canonicalPayload: string;
  payloadSha256: string;
  notBefore: Date;
  deliveryExpiresAt: Date;
  returnState: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  dpopJkt: string;
  immutableDigest: string;
};

export type StoredEnvelope = CredentialEnvelope;

export type DelegationRequestRecord = {
  id: string;
  clientId: string;
  externalJobId: string;
  revision: number;
  idempotencyKey: string;
  callbackUri: string;
  expectedPrismUserId: string;
  action: typeof DELEGATED_ACTION;
  executionMode: typeof DELEGATED_EXECUTION_MODE;
  teamId: string;
  channelId: string;
  payloadEnvelope: StoredEnvelope;
  payloadSha256: string;
  returnStateEnvelope: StoredEnvelope;
  codeChallenge: string;
  dpopJkt: string;
  notBefore: Date;
  approvalExpiresAt: Date;
  deliveryExpiresAt: Date;
  state: "pending" | "approved" | "denied" | "cancelled" | "expired";
};

export type DelegatedConsentIdentity = {
  prismUserId: string;
  slackConnectionId: string;
  slackUserId: string;
  slackUserDisplayName: string | null;
  teamId: string;
  teamName: string | null;
};

export type DelegatedConsentPreview = {
  requestId: string;
  externalJobId: string;
  revision: number;
  payload: DelegatedSlackPayload;
  payloadSha256: string;
  channelId: string;
  notBefore: Date;
  deliveryExpiresAt: Date;
  approvalExpiresAt: Date;
  identity: DelegatedConsentIdentity;
};

export type DelegatedTokenResponse = {
  grant_token: string;
  token_type: "DPoP";
  expires_in: number;
  grant_id: string;
  client_id: string;
  external_job_id: string;
  revision: number;
  prism_user_id: string;
  slack_user_id: string;
  team_id: string;
  channel_id: string;
  payload_sha256: string;
  not_before: string;
  expires_at: string;
};

export type DelegatedExecutionResponse = {
  state: "sent" | "failed" | "outcome_unknown";
  grant_id: string;
  external_job_id: string;
  revision: number;
  prism_user_id: string;
  slack_user_id: string;
  team_id: string;
  channel_id: string;
  payload_sha256: string;
  slack_ts: string | null;
  error: string | null;
};

export type DelegatedErrorCode =
  | "access_denied"
  | "feature_disabled"
  | "idempotency_conflict"
  | "invalid_client_proof"
  | "invalid_dpop_proof"
  | "invalid_grant"
  | "invalid_request"
  | "not_yet_valid"
  | "lifecycle_conflict"
  | "not_found"
  | "policy_denied"
  | "rate_limited"
  | "server_error";

export type DelegatedErrorDecision = {
  kind: "error";
  status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500;
  error: DelegatedErrorCode;
  retryAfterSeconds?: number;
};

export class DelegatedDeliveryStoreError extends Error {
  constructor(
    readonly code:
      | "expired"
      | "idempotency_conflict"
      | "lifecycle_conflict"
      | "not_found"
      | "not_yet_valid"
      | "policy_denied"
      | "proof_replay"
      | "rate_limited",
    readonly retryAfterSeconds?: number
  ) {
    super(code);
    this.name = "DelegatedDeliveryStoreError";
  }
}
