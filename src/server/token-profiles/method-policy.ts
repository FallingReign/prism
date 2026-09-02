import "server-only";

import { classifySlackMethod, isValidSlackWebApiMethod, type MethodCategory, type MethodClassification } from "../slack/method-registry";
import type { DeveloperTokenConfig } from "./developer-token";
import {
  executionIdentityStatus,
  resolvePresentedDeveloperToken,
  type LocalToolTokenStore,
  type ResolvedDeveloperToken
} from "./local-tool-status";
import type { CapabilityMap } from "./presets";

export type SlackMethodPolicyStore = LocalToolTokenStore & {
  /**
   * Resolve a requested workspace against the exact Slack connection that owns
   * the presented developer token. Workspace installs must match their
   * installed team; organization installs must have an explicit active grant.
   */
  isWorkspaceAllowed?(input: { slackConnectionId: string; workspaceId: string }): Promise<boolean>;
};

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

export type SlackPolicyAuditContext = {
  prismUserId?: string | null;
  slackConnectionId?: string | null;
  tokenProfileId?: string | null;
  tokenProfileName?: string | null;
  slackUserId?: string | null;
  slackTeamId?: string | null;
  slackEnterpriseId?: string | null;
};

export type SlackMethodPolicyDecision =
  | {
      kind: "allowed";
      method: string;
      category: MethodCategory;
      tokenProfileId: string;
      slackConnectionId?: string | null;
      auditContext: SlackPolicyAuditContext;
      capabilityMap: CapabilityMap;
      mutation: CapabilityMap["mutation"];
      executionIdentity: ReturnType<typeof executionIdentityStatus>;
    }
  | { kind: "denied" | "unsupported" | "auth_failed"; httpStatus: number; body: SlackPolicyBody; auditContext?: SlackPolicyAuditContext };

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

  const resolved = resolution.resolved;
  const fullWebApi = resolved.capabilityMap.webApi?.mode === "all_methods";
  if (fullWebApi && !isValidSlackWebApiMethod(method)) return invalidMethod(method, requestId, resolved);
  const classification = classifySlackMethod(method);
  if (!classification.supported && !fullWebApi) return unsupported(method, requestId, classification, resolved);

  const effectiveClassification: Extract<MethodClassification, { supported: true }> = fullWebApi
    ? {
        method,
        category: "web_api.full",
        supported: true,
        status: "supported",
        requiredCapabilities: [],
        requiresSurface: false
      }
    : (classification as Extract<MethodClassification, { supported: true }>);

  const workspaceDenial = await checkWorkspace(method, requestId, effectiveClassification, resolved, requestContext, store, fullWebApi);
  if (workspaceDenial) return workspaceDenial;

  const surfaceDenial = checkSurface(method, requestId, effectiveClassification, resolved, requestContext);
  if (surfaceDenial) return surfaceDenial;

  const missingCapability = effectiveClassification.requiredCapabilities.find((capability) => !resolved.capabilityMap.actions[capability]);
  if (missingCapability) return capabilityDenied(method, requestId, effectiveClassification, resolved, missingCapability);

  const executionIdentity = executionIdentityStatus(resolved);
  if (!executionIdentity.available) {
    return deniedBody(method, requestId, effectiveClassification.category, "execution_identity_unavailable", "not_allowed", resolved, {
      unavailableReason: executionIdentity.unavailableReason ?? "missing_execution_identity"
    });
  }

  return {
    kind: "allowed",
    method,
    category: effectiveClassification.category,
    tokenProfileId: resolved.tokenProfileId,
    slackConnectionId: resolved.slackConnectionId,
    auditContext: auditContext(resolved),
    capabilityMap: resolved.capabilityMap,
    mutation: resolved.capabilityMap.mutation,
    executionIdentity
  };
}

async function checkWorkspace(
  method: string,
  requestId: string,
  classification: Extract<MethodClassification, { supported: true }>,
  resolved: ResolvedDeveloperToken,
  requestContext: SlackMethodPolicyContext,
  store: SlackMethodPolicyStore,
  requireExplicitWorkspace = false
): Promise<SlackMethodPolicyDecision | null> {
  const workspaceId = requestContext.workspaceId?.trim();
  if (!workspaceId) {
    // A workspace installation is already bound to exactly one team, so its
    // legacy callers may omit the header. An organization installation is not
    // bound to a default team: require an explicit header so a caller cannot
    // bypass the grant lookup by placing team_id only in the Slack payload.
    if (resolved.slackTeamId && !requireExplicitWorkspace) return null;
    return deniedBody(method, requestId, classification.category, "workspace_required", "not_allowed", resolved);
  }

  // A workspace-scoped installation never receives cross-workspace access.
  if (resolved.slackTeamId) {
    if (workspaceId !== resolved.slackTeamId) {
      return deniedBody(method, requestId, classification.category, "workspace_denied", "not_allowed", resolved);
    }
    return null;
  }

  // An organization installation is deliberately not equivalent to every
  // workspace in that organization. Fail closed unless the exact connection
  // has an active workspace grant at the point of forwarding.
  if (!resolved.slackConnectionId || !store.isWorkspaceAllowed) {
    return deniedBody(method, requestId, classification.category, "workspace_denied", "not_allowed", resolved);
  }
  if (!(await store.isWorkspaceAllowed({ slackConnectionId: resolved.slackConnectionId, workspaceId }))) {
    return deniedBody(method, requestId, classification.category, "workspace_denied", "not_allowed", resolved);
  }
  return null;
}

function invalidMethod(method: string, requestId: string, resolved: ResolvedDeveloperToken): SlackMethodPolicyDecision {
  return {
    kind: "unsupported",
    httpStatus: 200,
    auditContext: auditContext(resolved),
    body: {
      ok: false,
      error: "method_not_supported",
      prism: {
        requestId,
        errorClass: "invalid_method",
        method,
        category: "web_api.full"
      }
    }
  };
}

function checkSurface(
  method: string,
  requestId: string,
  classification: Extract<MethodClassification, { supported: true }>,
  resolved: ResolvedDeveloperToken,
  requestContext: SlackMethodPolicyContext
): SlackMethodPolicyDecision | null {
  if (!classification.requiresSurface) return null;
  if (!requestContext.surface) {
    return deniedBody(method, requestId, classification.category, "surface_required", "not_allowed", resolved);
  }
  const surfaceCapability = surfaceCapabilityFor(requestContext.surface);
  if (!resolved.capabilityMap.surfaces[surfaceCapability]) {
    return deniedBody(method, requestId, classification.category, "surface_denied", "not_allowed", resolved, { requiredCapability: surfaceCapability });
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

function unsupported(
  method: string,
  requestId: string,
  classification: Extract<MethodClassification, { supported: false }>,
  resolved: ResolvedDeveloperToken
): SlackMethodPolicyDecision {
  return {
    kind: "unsupported",
    httpStatus: 200,
    auditContext: auditContext(resolved),
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
    auditContext: resolved ? auditContext(resolved) : undefined,
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

function auditContext(resolved: ResolvedDeveloperToken): SlackPolicyAuditContext {
  return {
    prismUserId: resolved.prismUserId,
    slackConnectionId: resolved.slackConnectionId,
    tokenProfileId: resolved.tokenProfileId,
    tokenProfileName: resolved.tokenProfileName,
    slackUserId: resolved.slackUserId,
    slackTeamId: resolved.slackTeamId,
    slackEnterpriseId: resolved.slackEnterpriseId
  };
}
