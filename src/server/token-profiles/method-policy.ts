import "server-only";

import { classifySlackMethod, type MethodCategory, type MethodClassification } from "../slack/method-registry";
import type { DeveloperTokenConfig } from "./developer-token";
import {
  executionIdentityStatus,
  resolvePresentedDeveloperToken,
  type LocalToolTokenStore,
  type ResolvedDeveloperToken
} from "./local-tool-status";
import type { CapabilityMap } from "./presets";

export type SlackMethodPolicyStore = LocalToolTokenStore;

export type SlackSurface = "public_channel" | "private_channel" | "dm" | "mpim" | "search" | "files_metadata";

export type SlackMethodPolicyContext = {
  workspaceId?: string;
  surface?: SlackSurface;
};

export type SlackPolicyBody = {
  ok: false;
  error: string;
  prism: {
    requestId: string;
    errorClass: string;
    method: string;
    category?: MethodCategory;
    requiredCapability?: string;
    tokenProfileId?: string;
    unavailableReason?: string | null;
    mutation?: CapabilityMap["mutation"];
  };
};

export type SlackMethodPolicyDecision =
  | {
      kind: "allowed";
      method: string;
      category: MethodCategory;
      tokenProfileId: string;
      slackConnectionId?: string | null;
      capabilityMap: CapabilityMap;
      mutation: CapabilityMap["mutation"];
      executionIdentity: ReturnType<typeof executionIdentityStatus>;
    }
  | { kind: "denied" | "unsupported" | "auth_failed"; httpStatus: number; body: SlackPolicyBody };

export async function evaluateSlackMethodPolicy({
  store,
  bearerToken,
  developerTokenConfig,
  method,
  requestId,
  requestContext = {},
  now = new Date()
}: {
  store: SlackMethodPolicyStore;
  bearerToken: string | undefined;
  developerTokenConfig: DeveloperTokenConfig;
  method: string;
  requestId: string;
  requestContext?: SlackMethodPolicyContext;
  now?: Date;
}): Promise<SlackMethodPolicyDecision> {
  const resolution = await resolvePresentedDeveloperToken({ store, bearerToken, developerTokenConfig, requestId, now });
  if (resolution.kind === "result") return authFailure(method, requestId, resolution.result.httpStatus, resolution.result.body.token.status);

  const classification = classifySlackMethod(method);
  if (!classification.supported) return unsupported(method, requestId, classification);

  const resolved = resolution.resolved;
  const workspaceDenial = checkWorkspace(method, requestId, classification, resolved, requestContext);
  if (workspaceDenial) return workspaceDenial;

  const surfaceDenial = checkSurface(method, requestId, classification, resolved.capabilityMap, requestContext);
  if (surfaceDenial) return surfaceDenial;

  const missingCapability = classification.requiredCapabilities.find((capability) => !resolved.capabilityMap.actions[capability]);
  if (missingCapability) return capabilityDenied(method, requestId, classification, resolved, missingCapability);

  const executionIdentity = executionIdentityStatus(resolved);
  if (!executionIdentity.available) {
    return deniedBody(method, requestId, classification.category, "execution_identity_unavailable", "not_allowed", resolved, {
      unavailableReason: executionIdentity.unavailableReason ?? "missing_execution_identity"
    });
  }

  return {
    kind: "allowed",
    method,
    category: classification.category,
    tokenProfileId: resolved.tokenProfileId,
    slackConnectionId: resolved.slackConnectionId,
    capabilityMap: resolved.capabilityMap,
    mutation: resolved.capabilityMap.mutation,
    executionIdentity
  };
}

function checkWorkspace(
  method: string,
  requestId: string,
  classification: Extract<MethodClassification, { supported: true }>,
  resolved: ResolvedDeveloperToken,
  requestContext: SlackMethodPolicyContext
): SlackMethodPolicyDecision | null {
  if (requestContext.workspaceId && resolved.slackTeamId && requestContext.workspaceId !== resolved.slackTeamId) {
    return deniedBody(method, requestId, classification.category, "workspace_denied", "not_allowed", resolved);
  }
  return null;
}

function checkSurface(
  method: string,
  requestId: string,
  classification: Extract<MethodClassification, { supported: true }>,
  capabilityMap: CapabilityMap,
  requestContext: SlackMethodPolicyContext
): SlackMethodPolicyDecision | null {
  if (!classification.requiresSurface) return null;
  if (!requestContext.surface) {
    return deniedBody(method, requestId, classification.category, "surface_required", "not_allowed");
  }
  const surfaceCapability = surfaceCapabilityFor(requestContext.surface);
  if (!capabilityMap.surfaces[surfaceCapability]) {
    return deniedBody(method, requestId, classification.category, "surface_denied", "not_allowed", undefined, { requiredCapability: surfaceCapability });
  }
  return null;
}

function surfaceCapabilityFor(surface: SlackSurface): keyof CapabilityMap["surfaces"] {
  if (surface === "public_channel") return "publicChannels";
  if (surface === "private_channel") return "privateChannels";
  if (surface === "dm") return "directMessages";
  if (surface === "mpim") return "groupDirectMessages";
  if (surface === "files_metadata") return "filesMetadata";
  return "search";
}

function capabilityDenied(
  method: string,
  requestId: string,
  classification: Extract<MethodClassification, { supported: true }>,
  resolved: ResolvedDeveloperToken,
  requiredCapability: string
): SlackMethodPolicyDecision {
  return deniedBody(method, requestId, classification.category, "capability_denied", "not_allowed", resolved, { requiredCapability });
}

function unsupported(method: string, requestId: string, classification: Extract<MethodClassification, { supported: false }>): SlackMethodPolicyDecision {
  return {
    kind: "unsupported",
    httpStatus: 200,
    body: {
      ok: false,
      error: "method_not_supported",
      prism: {
        requestId,
        errorClass: classification.status === "deferred" ? "deferred_surface" : "unsupported_method",
        method,
        category: classification.category
      }
    }
  };
}

function authFailure(method: string, requestId: string, httpStatus: number, tokenStatus: string): SlackMethodPolicyDecision {
  const error = tokenStatus === "expired" ? "token_expired" : tokenStatus === "revoked" ? "token_revoked" : "invalid_auth";
  return {
    kind: "auth_failed",
    httpStatus,
    body: {
      ok: false,
      error,
      prism: {
        requestId,
        errorClass: error,
        method
      }
    }
  };
}

function deniedBody(
  method: string,
  requestId: string,
  category: MethodCategory,
  errorClass: string,
  error: string,
  resolved?: ResolvedDeveloperToken,
  extra: { requiredCapability?: string; unavailableReason?: string } = {}
): SlackMethodPolicyDecision {
  return {
    kind: "denied",
    httpStatus: 200,
    body: {
      ok: false,
      error,
      prism: {
        requestId,
        errorClass,
        method,
        category,
        requiredCapability: extra.requiredCapability,
        tokenProfileId: resolved?.tokenProfileId,
        unavailableReason: extra.unavailableReason,
        mutation: resolved?.capabilityMap.mutation
      }
    }
  };
}
