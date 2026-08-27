import "server-only";

import type { CredentialEnvelope } from "../credentials/encryption";
import type { VerifiedProofReplay } from "./proof";
import type {
  DelegatedConsentIdentity,
  DelegationRequestInput,
  DelegationRequestRecord
} from "./types";

export type DelegatedGrantExecutionBinding = {
  grantId: string;
  requestId: string;
  externalJobId: string;
  revision: number;
  dpopJkt: string;
  prismUserId: string;
  slackConnectionId: string;
  connectionIdSnapshot: string;
  slackUserId: string;
  teamId: string;
  channelId: string;
  payloadEnvelope: CredentialEnvelope;
  payloadSha256: string;
  notBefore: Date;
  expiresAt: Date;
  state: "active" | "executing" | "sent" | "failed" | "cancelled" | "expired" | "outcome_unknown";
  slackTs: string | null;
  lastErrorCode: string | null;
};

export type DelegatedStoreLimits = {
  statusRetentionMs: number;
  rateWindowMs: number;
  maxRequestsPerSource: number;
  maxRequestsPerClient: number;
  maxRequestsPerUser: number;
  maxRequestsPerChannel: number;
  maxOutstandingPendingPerSource: number;
  maxOutstandingPendingPerClient: number;
  maxOutstandingPendingPerUser: number;
  cleanupBatchSize: number;
};

export type StoredDelegationRequestResult = {
  kind: "created" | "existing";
  request: DelegationRequestRecord;
  approvalHandleEnvelope: CredentialEnvelope;
};

export type DelegatedConsentLookup =
  | { kind: "not_found"; requestId?: string }
  | { kind: "expired"; requestId?: string }
  | { kind: "login_required"; requestId?: string }
  | { kind: "policy_denied"; requestId?: string }
  | {
      kind: "ready";
      request: DelegationRequestRecord;
      identity: DelegatedConsentIdentity;
    };

export type DelegatedApprovalResult = {
  request: DelegationRequestRecord;
  identity: DelegatedConsentIdentity;
};

export type DelegatedGrantExchangeResult = {
  grantId: string;
  clientId: string;
  externalJobId: string;
  revision: number;
  prismUserId: string;
  slackUserId: string;
  teamId: string;
  channelId: string;
  payloadSha256: string;
  notBefore: Date;
  expiresAt: Date;
};

export type DelegatedDeliveryStore = {
  createRequest(input: {
    requestId: string;
    approvalHandleHash: string;
    approvalHandleEnvelope: CredentialEnvelope;
    sourceIdentifier: string;
    request: DelegationRequestInput;
    payloadEnvelope: CredentialEnvelope;
    returnStateEnvelope: CredentialEnvelope;
    approvalExpiresAt: Date;
    proofReplay: VerifiedProofReplay;
    limits: DelegatedStoreLimits;
    now: Date;
  }): Promise<StoredDelegationRequestResult>;
  loadConsent(input: {
    handleHash: string;
    sessionTokenHash: string | null;
    now: Date;
  }): Promise<DelegatedConsentLookup>;
  saveOAuthResumeHandle(input: {
    requestId: string;
    handleHash: string;
    now: Date;
  }): Promise<boolean>;
  approveRequest(input: {
    requestId: string;
    sessionTokenHash: string | null;
    codeHash: string;
    codeExpiresAt: Date;
    now: Date;
  }): Promise<DelegatedApprovalResult | null>;
  denyRequest(input: {
    requestId: string;
    sessionTokenHash: string | null;
    now: Date;
  }): Promise<DelegationRequestRecord | null>;
  denyRequestAfterOAuth(input: { requestId: string; now: Date }): Promise<DelegationRequestRecord | null>;
  loadCodeBinding(input: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    now: Date;
  }): Promise<{ kind: "ready"; dpopJkt: string } | { kind: "expired" } | null>;
  exchangeCodeForGrant(input: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    proofReplay: VerifiedProofReplay;
    grantId: string;
    grantHash: string;
    pepperId: string;
    statusRetentionMs: number;
    now: Date;
  }): Promise<DelegatedGrantExchangeResult | null>;
  loadGrantExecutionBinding(input: {
    grantHash: string;
    pepperId: string;
  }): Promise<DelegatedGrantExecutionBinding | null>;
  claimGrantExecution(input: {
    grantHash: string;
    pepperId: string;
    proofReplay: VerifiedProofReplay;
    leaseId: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<DelegatedGrantExecutionBinding>;
  finishGrantExecution(input: {
    grantId: string;
    leaseId: string;
    state: "sent" | "failed" | "outcome_unknown";
    slackRequestId?: string | null;
    slackTs?: string | null;
    errorCode?: string | null;
    httpStatus?: number | null;
    upstreamCalled: boolean;
    now: Date;
  }): Promise<DelegatedGrantExecutionBinding>;
  markGrantUpstreamCalled(input: {
    grantId: string;
    leaseId: string;
    now: Date;
  }): Promise<void>;
};
