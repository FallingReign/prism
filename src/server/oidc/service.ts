import "server-only";

import type { OidcProviderConfig } from "../config";
import type {
  OidcAccessTokenIdentity,
  OidcPendingAuthorizationRequest,
  OidcSessionIdentity,
  OidcStore
} from "./postgres-store";
import {
  authorizationCodeRedirect,
  authorizationErrorRedirect,
  validateAuthorizationRequest,
  validateTokenRequest
} from "./provider";
import { UNATTRIBUTED_OIDC_SOURCE } from "./request-source";
import type { OidcSigningService } from "./signing";
import type { PlaytestAppCredential } from "../token-profiles/first-party-app";

const PENDING_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;
const OPAQUE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const AUTHORIZATION_DISPLAY_NAME_ENRICHMENT_DEADLINE_MS = 2_000;

export type OidcRedirectDecision = { kind: "redirect"; location: string };
export type OidcErrorDecision = {
  kind: "error";
  status: 400 | 401 | 429 | 500;
  error: "invalid_request" | "invalid_grant" | "invalid_token" | "server_error" | "temporarily_unavailable" | "unsupported_grant_type";
  retryAfterSeconds?: number;
};

export type OidcSessionDisplayNameEnricher = (input: {
  identity: OidcSessionIdentity;
  now: Date;
}) => Promise<void>;

export type PlaytestAppCredentialIssuer = (input: {
  prismUserId: string;
  slackConnectionId: string;
  now: Date;
}) => Promise<PlaytestAppCredential | null>;

export async function authorizeOidcRequest(input: {
  url: URL;
  sessionToken?: string;
  store: OidcStore;
  config: OidcProviderConfig;
  sourceIdentifier?: string;
  now?: Date;
  enrichSessionDisplayName?: OidcSessionDisplayNameEnricher;
}): Promise<OidcRedirectDecision | OidcErrorDecision> {
  const now = input.now ?? new Date();
  const resume = parseResumeRequest(input.url);
  if (resume.kind === "invalid") return invalidRequest();
  if (resume.kind === "resume") {
    return resumeOidcAuthorization({ ...input, ...resume, now });
  }

  const validation = validateAuthorizationRequest(input.url, input.config);
  // An untrusted or malformed callback URI must never receive a redirect.
  if (validation.kind !== "valid") return invalidRequest();
  const request = validation.request;
  const permit = await input.store.consumeAuthorizationRequestPermit({
    clientId: request.clientId,
    sourceIdentifier: input.sourceIdentifier ?? UNATTRIBUTED_OIDC_SOURCE,
    now,
    windowMs: input.config.abuseProtection.authorizeWindowMs,
    maxRequestsPerSource: input.config.abuseProtection.maxAuthorizeRequestsPerSource,
    maxRequestsPerClient: input.config.abuseProtection.maxAuthorizeRequestsPerClient,
    cleanupBatchSize: input.config.abuseProtection.cleanupBatchSize
  });
  if (permit.kind === "limited") return rateLimited(permit.retryAfterSeconds);

  const identity = await resolveEligibleIdentityWithBestEffortEnrichment(input, now);
  if (identity) {
    return issueCodeRedirect({ request, identity, store: input.store, now });
  }

  const pending = await input.store.createPendingAuthorizationRequest({
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    state: request.state,
    nonce: request.nonce,
    scope: request.scope,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    expiresAt: new Date(now.getTime() + PENDING_REQUEST_TTL_MS),
    sourceIdentifier: input.sourceIdentifier ?? UNATTRIBUTED_OIDC_SOURCE,
    now,
    maxOutstandingPerSource: input.config.abuseProtection.maxOutstandingPendingPerSource,
    maxOutstandingPerClient: input.config.abuseProtection.maxOutstandingPendingPerClient
  });
  if (pending.kind === "limited") return rateLimited(pending.retryAfterSeconds);
  const slackLogin = new URL("/v1/slack/oauth/start", input.config.issuer);
  slackLogin.searchParams.set("oidc_request", pending.requestId);
  return { kind: "redirect", location: slackLogin.toString() };
}

async function resumeOidcAuthorization(input: {
  requestId: string;
  oauthError: "access_denied" | null;
  sessionToken?: string;
  store: OidcStore;
  now: Date;
  enrichSessionDisplayName?: OidcSessionDisplayNameEnricher;
}): Promise<OidcRedirectDecision | OidcErrorDecision> {
  if (input.oauthError) {
    const cancelled = await input.store.consumePendingAuthorizationRequest({
      requestId: input.requestId,
      now: input.now
    });
    if (!cancelled) return invalidRequest();
    return {
      kind: "redirect",
      location: authorizationErrorRedirect(cancelled, "access_denied").toString()
    };
  }

  const pending = await input.store.loadPendingAuthorizationRequest({ requestId: input.requestId, now: input.now });
  if (!pending) return invalidRequest();
  const identity = await resolveEligibleIdentityWithBestEffortEnrichment(input, input.now);
  if (!identity) {
    const consumed = await input.store.consumePendingAuthorizationRequest({ requestId: input.requestId, now: input.now });
    if (!consumed) return invalidRequest();
    return {
      kind: "redirect",
      location: authorizationErrorRedirect(consumed, "login_required").toString()
    };
  }

  try {
    return await issueCodeRedirect({ request: pending, identity, requestId: input.requestId, store: input.store, now: input.now });
  } catch {
    // The pending handle may have been consumed concurrently. Do not leak which
    // part of the authorization transaction failed and never reuse its callback.
    return invalidRequest();
  }
}

async function issueCodeRedirect(input: {
  request: Pick<OidcPendingAuthorizationRequest, "clientId" | "redirectUri" | "state" | "nonce" | "scope" | "codeChallenge" | "codeChallengeMethod">;
  identity: OidcSessionIdentity;
  requestId?: string;
  store: OidcStore;
  now: Date;
}): Promise<OidcRedirectDecision> {
  const issued = await input.store.issueAuthorizationCode({
    requestId: input.requestId,
    clientId: input.request.clientId,
    prismUserId: input.identity.prismUserId,
    slackConnectionId: input.identity.slackConnectionId,
    redirectUri: input.request.redirectUri,
    nonce: input.request.nonce,
    scope: input.request.scope,
    codeChallenge: input.request.codeChallenge,
    codeChallengeMethod: input.request.codeChallengeMethod,
    authTime: input.identity.authTime,
    expiresAt: new Date(input.now.getTime() + AUTHORIZATION_CODE_TTL_MS),
    now: input.now
  });
  return {
    kind: "redirect",
    location: authorizationCodeRedirect(input.request, issued.code).toString()
  };
}

export async function exchangeOidcCode(input: {
  params: URLSearchParams;
  store: OidcStore;
  signing: OidcSigningService;
  config: OidcProviderConfig;
  issuePlaytestAppCredential?: PlaytestAppCredentialIssuer;
  now?: Date;
}): Promise<
  | {
      kind: "success";
      body: {
        access_token: string;
        token_type: "Bearer";
        expires_in: number;
        scope: string;
        id_token: string;
        prism_app_token?: string;
        prism_app_token_expires_in?: number;
        prism_app_token_profile_id?: string;
      };
    }
  | OidcErrorDecision
> {
  const now = input.now ?? new Date();
  const validation = validateTokenRequest(input.params, input.config);
  if (validation.kind !== "valid") {
    return { kind: "error", status: 400, error: validation.error };
  }

  const request = validation.request;
  const exchanged = await input.store.exchangeAuthorizationCode({
    code: request.code,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeVerifier: request.codeVerifier,
    now,
    accessTokenExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS)
  });
  if (!exchanged) return { kind: "error", status: 400, error: "invalid_grant" };
  const code = exchanged.authorizationCode;
  const identity = await input.store.resolveAccessToken({ token: exchanged.token, now });
  if (
    !identity ||
    identity.clientId !== input.config.playtestClient.clientId ||
    identity.prismUserId !== code.prismUserId ||
    identity.slackConnectionId !== code.slackConnectionId ||
    identity.scope !== code.scope
  ) {
    return { kind: "error", status: 500, error: "server_error" };
  }

  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresIn = Math.floor(ACCESS_TOKEN_TTL_MS / 1000);
  const playtestInitialAdminEligible = await resolvePlaytestInitialAdminEligibility({
    clientId: code.clientId,
    playtestClientId: input.config.playtestClient.clientId,
    prismUserId: code.prismUserId,
    store: input.store
  });
  const idToken = await input.signing.sign({
    iss: input.config.issuer,
    sub: code.prismUserId,
    aud: code.clientId,
    azp: code.clientId,
    iat: issuedAt,
    exp: issuedAt + expiresIn,
    auth_time: Math.floor(code.authTime.getTime() / 1000),
    nonce: code.nonce,
    ...identityClaims(identity, code.scope),
    ...(playtestInitialAdminEligible ? { playtest_initial_admin_eligible: true } : {})
  });
  const appCredential = await bestEffortPlaytestAppCredential({
    issuer: input.issuePlaytestAppCredential,
    clientId: code.clientId,
    playtestClientId: input.config.playtestClient.clientId,
    prismUserId: code.prismUserId,
    slackConnectionId: code.slackConnectionId,
    now
  });
  return {
    kind: "success",
    body: {
      access_token: exchanged.token,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: code.scope,
      id_token: idToken,
      ...(appCredential
        ? {
            prism_app_token: appCredential.token,
            prism_app_token_expires_in: appCredential.expiresIn,
            prism_app_token_profile_id: appCredential.profileId
          }
        : {})
    }
  };
}

async function bestEffortPlaytestAppCredential(input: {
  issuer: PlaytestAppCredentialIssuer | undefined;
  clientId: string;
  playtestClientId: string;
  prismUserId: string;
  slackConnectionId: string;
  now: Date;
}): Promise<PlaytestAppCredential | null> {
  if (!input.issuer || input.clientId !== input.playtestClientId) return null;
  try {
    return await input.issuer({
      prismUserId: input.prismUserId,
      slackConnectionId: input.slackConnectionId,
      now: input.now
    });
  } catch {
    // Authentication remains available when optional Slack-delivery authority
    // cannot be issued. Playtest will present sending as unavailable.
    return null;
  }
}

async function resolveEligibleIdentityWithBestEffortEnrichment(
  input: {
    sessionToken?: string;
    store: OidcStore;
    enrichSessionDisplayName?: OidcSessionDisplayNameEnricher;
  },
  now: Date
): Promise<OidcSessionIdentity | null> {
  const identity = await input.store.resolveEligiblePrismSessionIdentity({
    sessionToken: input.sessionToken,
    now
  });
  const enricher = input.enrichSessionDisplayName;
  if (!identity || identity.slackUserDisplayName || !enricher) return identity;

  const attempt = (async () => {
    await enricher({ identity, now });
    return await input.store.resolveEligiblePrismSessionIdentity({
      sessionToken: input.sessionToken,
      now
    });
  })().then(
    (refreshedIdentity) => ({ kind: "completed" as const, refreshedIdentity }),
    () => ({ kind: "failed" as const })
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: "timed_out" }>((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve({ kind: "timed_out" }),
      AUTHORIZATION_DISPLAY_NAME_ENRICHMENT_DEADLINE_MS
    );
  });
  const outcome = await Promise.race([attempt, deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  return outcome.kind === "completed" ? outcome.refreshedIdentity ?? identity : identity;
}

async function resolvePlaytestInitialAdminEligibility(input: {
  clientId: string;
  playtestClientId: string;
  prismUserId: string;
  store: OidcStore;
}): Promise<boolean> {
  if (input.clientId !== input.playtestClientId) return false;
  try {
    return await input.store.resolvePlaytestInitialAdminEligibility({ prismUserId: input.prismUserId });
  } catch {
    return false;
  }
}

export async function resolveOidcUserInfo(input: {
  authorization: string | null;
  store: OidcStore;
  config: OidcProviderConfig;
  now?: Date;
}): Promise<{ kind: "success"; body: Record<string, string> } | OidcErrorDecision> {
  const token = parseBearerToken(input.authorization);
  if (!token) return { kind: "error", status: 401, error: "invalid_token" };
  const identity = await input.store.resolveAccessToken({ token, now: input.now ?? new Date() });
  if (!identity || identity.clientId !== input.config.playtestClient.clientId) {
    return { kind: "error", status: 401, error: "invalid_token" };
  }
  return {
    kind: "success",
    body: { sub: identity.prismUserId, ...identityClaims(identity, identity.scope) }
  };
}

function identityClaims(identity: OidcAccessTokenIdentity, scope: string): Record<string, string> {
  const grantedScopes = new Set(scope.split(/\s+/).filter(Boolean));
  // Prism intentionally does not retain a Slack email address. Granting
  // `email` therefore adds no claim; it must never unlock profile/Slack data.
  if (!grantedScopes.has("profile")) return {};
  const displayName = identity.slackUserDisplayName ?? identity.slackUserId;
  return {
    name: displayName,
    preferred_username: displayName,
    slack_user_id: identity.slackUserId,
    slack_team_id: identity.teamId,
    ...(identity.enterpriseId ? { slack_enterprise_id: identity.enterpriseId } : {})
  };
}

function parseResumeRequest(url: URL):
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "resume"; requestId: string; oauthError: "access_denied" | null } {
  if (!url.searchParams.has("request")) return { kind: "none" };
  if ([...url.searchParams.keys()].some((key) => key !== "request" && key !== "error")) return { kind: "invalid" };
  const requests = url.searchParams.getAll("request");
  const errors = url.searchParams.getAll("error");
  if (
    requests.length !== 1 || !OPAQUE_HANDLE_PATTERN.test(requests[0]!) ||
    errors.length > 1 || (errors.length === 1 && errors[0] !== "access_denied")
  ) {
    return { kind: "invalid" };
  }
  return { kind: "resume", requestId: requests[0]!, oauthError: errors[0] === "access_denied" ? "access_denied" : null };
}

function parseBearerToken(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] ?? null;
}

function invalidRequest(): OidcErrorDecision {
  return { kind: "error", status: 400, error: "invalid_request" };
}

function rateLimited(retryAfterSeconds: number): OidcErrorDecision {
  return { kind: "error", status: 429, error: "temporarily_unavailable", retryAfterSeconds };
}
