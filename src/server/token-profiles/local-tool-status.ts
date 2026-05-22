import "server-only";

import { buildMethodAvailability, type MethodAvailability } from "../slack/method-registry";
import { hashDeveloperToken, type DeveloperTokenConfig } from "./developer-token";
import type { CapabilityMap, TokenProfilePreset } from "./presets";

export type ResolvedDeveloperToken = {
  tokenProfileId: string;
  tokenExpiresAt: Date | null;
  tokenRevokedAt: Date | null;
  profileStatus: "active" | "bootstrap" | "revoked";
  profileExpiresAt: Date | null;
  preset: TokenProfilePreset;
  capabilityMap: CapabilityMap;
  slackStatus: "healthy" | "reauth_required";
  slackLastErrorClass: string | null;
  hasUserCredential: boolean;
  hasBotCredential: boolean;
};

export type LocalToolTokenStore = {
  resolveDeveloperToken(input: { tokenHash: string; now: Date }): Promise<ResolvedDeveloperToken | null>;
};

export type LocalToolResult = {
  httpStatus: number;
  body: PrismStatusBody;
};

export type PrismStatusBody = {
  requestId: string;
  token:
    | { valid: true; status: "active"; tokenProfileId: string; expiresAt: string | null }
    | { valid: false; status: "invalid" | "expired" | "revoked"; tokenProfileId?: string; expiresAt?: string | null };
  slack?: {
    connected: boolean;
    status: "healthy" | "reauth_required";
    reauthRequired: boolean;
    lastErrorClass: string | null;
  };
  executionIdentity?: {
    configured: CapabilityMap["executionIdentity"];
    available: boolean;
    modes: { user: boolean; bot: boolean; automatic: boolean; selectable: boolean };
    unavailableReason: "slack_reauth_required" | "missing_user_identity" | "missing_bot_identity" | "missing_execution_identity" | null;
  };
};

export type PrismCapabilitiesBody = {
  requestId: string;
  token:
    | { status: "active"; tokenProfileId: string; expiresAt: string | null }
    | { valid: false; status: "invalid" | "expired" | "revoked"; tokenProfileId?: string; expiresAt?: string | null };
  slack?: PrismStatusBody["slack"];
  executionIdentity?: PrismStatusBody["executionIdentity"];
  capabilityMap?: CapabilityMap;
  categories?: MethodAvailability["categories"];
  methods?: MethodAvailability["methods"];
  unsupported?: MethodAvailability["unsupported"];
};

export async function getPrismTokenStatus({
  store,
  bearerToken,
  developerTokenConfig,
  requestId,
  now = new Date()
}: {
  store: LocalToolTokenStore;
  bearerToken: string | undefined;
  developerTokenConfig: DeveloperTokenConfig;
  requestId: string;
  now?: Date;
}): Promise<LocalToolResult> {
  const resolution = await resolvePresentedDeveloperToken({ store, bearerToken, developerTokenConfig, requestId, now });
  if (resolution.kind === "result") return resolution.result;

  return {
    httpStatus: 200,
    body: {
      requestId,
      token: activeTokenStatus(resolution.resolved),
      slack: slackStatus(resolution.resolved),
      executionIdentity: executionIdentityStatus(resolution.resolved)
    }
  };
}

export async function getPrismCapabilities({
  store,
  bearerToken,
  developerTokenConfig,
  requestId,
  now = new Date()
}: {
  store: LocalToolTokenStore;
  bearerToken: string | undefined;
  developerTokenConfig: DeveloperTokenConfig;
  requestId: string;
  now?: Date;
}): Promise<{ httpStatus: number; body: PrismCapabilitiesBody }> {
  const resolution = await resolvePresentedDeveloperToken({ store, bearerToken, developerTokenConfig, requestId, now });
  if (resolution.kind === "result") {
    return {
      httpStatus: resolution.result.httpStatus,
      body: { requestId, token: resolution.result.body.token as PrismCapabilitiesBody["token"] }
    };
  }

  const discovery = buildMethodAvailability(resolution.resolved.capabilityMap);
  return {
    httpStatus: 200,
    body: {
      requestId,
      token: {
        status: "active",
        tokenProfileId: resolution.resolved.tokenProfileId,
        expiresAt: earliestExpiry(resolution.resolved)?.toISOString() ?? null
      },
      slack: slackStatus(resolution.resolved),
      executionIdentity: executionIdentityStatus(resolution.resolved),
      capabilityMap: resolution.resolved.capabilityMap,
      categories: discovery.categories,
      methods: discovery.methods,
      unsupported: discovery.unsupported
    }
  };
}

export function executionIdentityStatus(resolved: ResolvedDeveloperToken): NonNullable<PrismStatusBody["executionIdentity"]> {
  const reauthRequired = resolved.slackStatus === "reauth_required";
  const modes = {
    user: !reauthRequired && resolved.hasUserCredential,
    bot: !reauthRequired && resolved.hasBotCredential,
    automatic: !reauthRequired && (resolved.hasUserCredential || resolved.hasBotCredential),
    selectable: !reauthRequired && resolved.hasUserCredential && resolved.hasBotCredential
  };
  const configured = resolved.capabilityMap.executionIdentity;
  const available = modes[configured];
  return {
    configured,
    available,
    modes,
    unavailableReason: available ? null : unavailableReason(configured, resolved, reauthRequired)
  };
}

async function resolvePresentedDeveloperToken({
  store,
  bearerToken,
  developerTokenConfig,
  requestId,
  now
}: {
  store: LocalToolTokenStore;
  bearerToken: string | undefined;
  developerTokenConfig: DeveloperTokenConfig;
  requestId: string;
  now: Date;
}): Promise<{ kind: "active"; resolved: ResolvedDeveloperToken } | { kind: "result"; result: LocalToolResult }> {
  if (!isPresentedDeveloperToken(bearerToken)) return { kind: "result", result: invalidResult(requestId) };

  const verifier = hashDeveloperToken(bearerToken, developerTokenConfig);
  const resolved = await store.resolveDeveloperToken({ tokenHash: verifier.tokenHash, now });
  if (!resolved) return { kind: "result", result: invalidResult(requestId) };

  const denied = deniedTokenResult(resolved, requestId, now);
  return denied ? { kind: "result", result: denied } : { kind: "active", resolved };
}

function deniedTokenResult(resolved: ResolvedDeveloperToken, requestId: string, now: Date): LocalToolResult | null {
  if (resolved.tokenRevokedAt || resolved.profileStatus === "revoked" || resolved.profileStatus === "bootstrap") {
    return {
      httpStatus: 403,
      body: {
        requestId,
        token: { valid: false, status: "revoked", tokenProfileId: resolved.tokenProfileId, expiresAt: earliestExpiry(resolved)?.toISOString() ?? null }
      }
    };
  }

  const expiresAt = earliestExpiry(resolved);
  if (expiresAt && expiresAt <= now) {
    return {
      httpStatus: 401,
      body: {
        requestId,
        token: { valid: false, status: "expired", tokenProfileId: resolved.tokenProfileId, expiresAt: expiresAt.toISOString() }
      }
    };
  }

  return null;
}

function activeTokenStatus(resolved: ResolvedDeveloperToken): Extract<PrismStatusBody["token"], { valid: true }> {
  return {
    valid: true,
    status: "active",
    tokenProfileId: resolved.tokenProfileId,
    expiresAt: earliestExpiry(resolved)?.toISOString() ?? null
  };
}

function slackStatus(resolved: ResolvedDeveloperToken): NonNullable<PrismStatusBody["slack"]> {
  return {
    connected: true,
    status: resolved.slackStatus,
    reauthRequired: resolved.slackStatus === "reauth_required",
    lastErrorClass: resolved.slackStatus === "reauth_required" ? "reauth_required" : null
  };
}

function unavailableReason(
  configured: CapabilityMap["executionIdentity"],
  resolved: ResolvedDeveloperToken,
  reauthRequired: boolean
): NonNullable<PrismStatusBody["executionIdentity"]>["unavailableReason"] {
  if (reauthRequired) return "slack_reauth_required";
  if (configured === "user" && !resolved.hasUserCredential) return "missing_user_identity";
  if (configured === "bot" && !resolved.hasBotCredential) return "missing_bot_identity";
  return "missing_execution_identity";
}

function earliestExpiry(resolved: ResolvedDeveloperToken): Date | null {
  const expiries = [resolved.tokenExpiresAt, resolved.profileExpiresAt].filter((date): date is Date => date instanceof Date);
  if (expiries.length === 0) return null;
  return expiries.sort((left, right) => left.getTime() - right.getTime())[0]!;
}

function invalidResult(requestId: string): LocalToolResult {
  return {
    httpStatus: 401,
    body: {
      requestId,
      token: { valid: false, status: "invalid" }
    }
  };
}

function isPresentedDeveloperToken(value: string | undefined): value is string {
  return typeof value === "string" && /^prism_dev_[A-Za-z0-9_-]{32,}$/.test(value);
}
