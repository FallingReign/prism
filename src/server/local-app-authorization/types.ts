import type { DeveloperTokenVerifier } from "../token-profiles/developer-token";

export type BeginLocalAppAuthorizationInput = {
  clientId: string;
  displayName: string;
  intendedUse: string;
  requestedPreset: "messages_only";
  executionIdentity: "user";
};

export type LocalAppAuthorizationPreview = {
  requestId: string;
  userCode: string | null;
  clientId: string;
  displayName: string;
  intendedUse: string;
  expiresAt: Date;
  rePairing: boolean;
  identity: {
    prismUserId: string;
    slackConnectionId: string;
    slackUserId: string;
    slackUserDisplayName: string | null;
    installationScope: "workspace" | "organization";
    teamId: string | null;
    teamName: string | null;
    enterpriseId: string | null;
    enterpriseName: string | null;
  };
};

export type LocalAppAuthorizationStore = {
  begin(input: {
    requestId: string;
    deviceCodeHash: string;
    userCodeHash: string;
    clientId: string;
    displayName: string;
    intendedUse: string;
    sourceKey: string;
    pollIntervalSeconds: number;
    expiresAt: Date;
    now: Date;
  }): Promise<"created" | "rate_limited">;
  consumeRequestRateLimit(input: {
    action: "consent" | "poll";
    sourceKey: string;
    now: Date;
  }): Promise<boolean>;
  resolveConsent(input: {
    userCodeHash: string | null;
    requestId: string | null;
    sessionTokenHash: string | null;
    now: Date;
  }): Promise<
    | { kind: "preview"; preview: Omit<LocalAppAuthorizationPreview, "userCode"> }
    | { kind: "login_required"; requestId: string }
    | { kind: "connection_unavailable"; requestId: string }
    | { kind: "unavailable" | "expired" }
  >;
  decide(input: {
    requestId: string;
    sessionTokenHash: string;
    decision: "approve" | "deny";
    now: Date;
    auditRequestId: string;
  }): Promise<"approved" | "denied" | "unavailable" | "connection_unavailable">;
  denyAfterOAuth(input: {
    requestId: string;
    now: Date;
  }): Promise<void>;
  exchange(input: {
    deviceCodeHash: string;
    clientId: string;
    now: Date;
    issueCredential(): { developerToken: string; verifier: DeveloperTokenVerifier };
    auditRequestId: string;
  }): Promise<
    | { kind: "pending" }
    | { kind: "slow_down"; retryAfterSeconds: number }
    | { kind: "denied" | "expired" | "invalid_grant" | "policy_denied" }
    | {
        kind: "issued";
        developerToken: string;
        tokenProfileId: string;
        clientId: string;
        subject: {
          prismUserId: string;
          slackUserId: string;
          installationScope: "workspace" | "organization";
          slackTeamId: string | null;
          slackEnterpriseId: string | null;
          workspaces: Array<{ teamId: string; teamName: string | null }>;
        };
      }
  >;
};
