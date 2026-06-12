import "server-only";

import { buildTokenProfilePolicy, type CapabilityMap, type ExecutionIdentity, type ExperimentTtl, type TokenProfilePreset } from "./presets";
import type { CreateTokenProfileInput, TokenRotationOverlap } from "./service";

export const GLOBAL_TOKEN_PROFILE_POLICY_SETTING_KEY = "global_token_profile_policy";

export type GlobalTokenProfilePolicy = {
  version: 1;
  presets: {
    allowed: TokenProfilePreset[];
    default: TokenProfilePreset;
  };
  executionIdentities: {
    allowed: ExecutionIdentity[];
    default: ExecutionIdentity;
  };
  capabilities: {
    defaults: CapabilityLimits;
    maximum: CapabilityLimits;
  };
  expiry: {
    allowNoExpiryForReadOnly: boolean;
    maximumDays: {
      readOnly: number | null;
      nonDestructive: number | null;  // Can be null to allow unlimited non-destructive tokens
      destructive: number;
    };
    allowedExperimentTtls: ExperimentTtl[];
    defaultExperimentTtl: ExperimentTtl | null;
  };
  mutation: {
    broadeningRequiresRotation: true;
    narrowingAppliesImmediately: true;
    maxRotationOverlap: TokenRotationOverlap;
  };
};

export type CapabilityLimits = {
  actions: CapabilityMap["actions"];
  surfaces: CapabilityMap["surfaces"];
};

export type GlobalPolicyReasonCode =
  | "preset_disallowed"
  | "execution_identity_disallowed"
  | "action_read_exceeds_maximum"
  | "action_search_exceeds_maximum"
  | "action_write_messages_exceeds_maximum"
  | "action_reactions_exceeds_maximum"
  | "action_files_metadata_exceeds_maximum"
  | "action_destructive_exceeds_maximum"
  | "surface_public_channels_exceeds_maximum"
  | "surface_private_channels_exceeds_maximum"
  | "surface_direct_messages_exceeds_maximum"
  | "surface_group_direct_messages_exceeds_maximum"
  | "surface_search_exceeds_maximum"
  | "surface_files_metadata_exceeds_maximum"
  | "experiment_ttl_disallowed"
  | "no_expiry_disallowed"
  | "expiry_exceeds_maximum"
  | "broadening_requires_rotation_disabled"
  | "narrowing_immediate_disabled"
  | "rotation_overlap_exceeds_maximum";

export type GlobalPolicyReason = {
  code: GlobalPolicyReasonCode;
  message: string;
};

export type GlobalPolicyStatus = { kind: "inside"; reasons: [] } | { kind: "outside"; reasons: GlobalPolicyReason[] };

export type TokenProfilePolicyCandidate = {
  preset: TokenProfilePreset;
  capabilityMap: CapabilityMap;
  expiresAt: Date | null;
  policyEffectiveAt: Date;
};

const PRESETS: TokenProfilePreset[] = ["read_only", "messages_only", "full_slack_bridge", "custom"];
const EXECUTION_IDENTITIES: ExecutionIdentity[] = ["automatic", "user", "bot", "selectable"];
const EXPERIMENT_TTLS: ExperimentTtl[] = ["24h", "7d"];
const ROTATION_OVERLAPS: TokenRotationOverlap[] = ["none", "15m", "1h", "24h"];
const DAY_MS = 24 * 60 * 60 * 1000;

type PolicyOverrides = {
  presets?: Partial<GlobalTokenProfilePolicy["presets"]>;
  executionIdentities?: Partial<GlobalTokenProfilePolicy["executionIdentities"]>;
  capabilities?: {
    defaults?: CapabilityLimits;
    maximum?: CapabilityLimits;
  };
  expiry?: Partial<GlobalTokenProfilePolicy["expiry"]>;
  mutation?: Partial<GlobalTokenProfilePolicy["mutation"]>;
};

export function buildCurrentGlobalTokenProfilePolicy(overrides: PolicyOverrides = {}): GlobalTokenProfilePolicy {
  const defaults = buildTokenProfilePolicy({ preset: "read_only", executionIdentity: "automatic" }).capabilityMap;
  const maximum = buildTokenProfilePolicy({ preset: "full_slack_bridge", executionIdentity: "selectable", destructive: true }).capabilityMap;

  const policy: GlobalTokenProfilePolicy = {
    version: 1,
    presets: {
      allowed: [...PRESETS],
      default: "read_only"
    },
    executionIdentities: {
      allowed: [...EXECUTION_IDENTITIES],
      default: "automatic"
    },
    capabilities: {
      defaults: { actions: { ...defaults.actions }, surfaces: { ...defaults.surfaces } },
      maximum: { actions: { ...maximum.actions }, surfaces: { ...maximum.surfaces } }
    },
    expiry: {
      allowNoExpiryForReadOnly: true,
      maximumDays: {
        readOnly: null,
        nonDestructive: null,  // Non-destructive tokens never expire
        destructive: 30
      },
      allowedExperimentTtls: [...EXPERIMENT_TTLS],
      defaultExperimentTtl: null
    },
    mutation: {
      broadeningRequiresRotation: true,
      narrowingAppliesImmediately: true,
      maxRotationOverlap: "24h"
    }
  };

  return {
    ...policy,
    presets: { ...policy.presets, ...overrides.presets },
    executionIdentities: { ...policy.executionIdentities, ...overrides.executionIdentities },
    capabilities: { ...policy.capabilities, ...overrides.capabilities },
    expiry: { ...policy.expiry, ...overrides.expiry },
    mutation: { ...policy.mutation, ...overrides.mutation }
  };
}

export function applyGlobalTokenProfilePolicyDefaults(input: CreateTokenProfileInput, policy: GlobalTokenProfilePolicy): CreateTokenProfileInput {
  return {
    ...input,
    preset: input.preset.length === 0 ? policy.presets.default : input.preset,
    executionIdentity: input.executionIdentity.length === 0 ? policy.executionIdentities.default : input.executionIdentity,
    experiment: input.experiment ?? policy.expiry.defaultExperimentTtl ?? undefined
  };
}

export function validateRequestedTokenProfilePolicy({
  input,
  capabilityMap,
  expiresAt,
  policyEffectiveAt,
  policy
}: {
  input: Pick<CreateTokenProfileInput, "preset" | "executionIdentity">;
  capabilityMap: CapabilityMap;
  expiresAt: Date | null;
  policyEffectiveAt: Date;
  policy: GlobalTokenProfilePolicy;
}): { kind: "allowed" } | { kind: "blocked"; code: "global_policy_violation"; message: string; reasons: GlobalPolicyReason[] } {
  const status = classifyGlobalTokenProfilePolicyStatus({ preset: input.preset, capabilityMap, expiresAt, policyEffectiveAt }, policy);
  if (status.kind === "inside") return { kind: "allowed" };
  return {
    kind: "blocked",
    code: "global_policy_violation",
    message: "Requested Token profile policy exceeds the Global Token profile policy.",
    reasons: status.reasons
  };
}

export function classifyGlobalTokenProfilePolicyStatus(candidate: TokenProfilePolicyCandidate, policy: GlobalTokenProfilePolicy): GlobalPolicyStatus {
  const reasons: GlobalPolicyReason[] = [];

  if (!policy.presets.allowed.includes(candidate.preset)) {
    reasons.push(reason("preset_disallowed"));
  }
  if (!policy.executionIdentities.allowed.includes(candidate.capabilityMap.executionIdentity)) {
    reasons.push(reason("execution_identity_disallowed"));
  }

  for (const key of Object.keys(candidate.capabilityMap.actions) as Array<keyof CapabilityMap["actions"]>) {
    if (candidate.capabilityMap.actions[key] && !policy.capabilities.maximum.actions[key]) {
      reasons.push(reason(actionReasonCode(key)));
    }
  }

  const surfaceKeys: Array<keyof CapabilityMap["surfaces"]> = ["publicChannels", "privateChannels", "directMessages", "groupDirectMessages", "search", "filesMetadata"];
  for (const key of surfaceKeys) {
    if (candidate.capabilityMap.surfaces[key] && !policy.capabilities.maximum.surfaces[key]) {
      reasons.push(reason(surfaceReasonCode(key)));
    }
  }

  if (candidate.capabilityMap.experiment.ttl && !policy.expiry.allowedExperimentTtls.includes(candidate.capabilityMap.experiment.ttl)) {
    reasons.push(reason("experiment_ttl_disallowed"));
  }
  if (!candidate.capabilityMap.mutation.broadeningRequiresRotation) {
    reasons.push(reason("broadening_requires_rotation_disabled"));
  }
  if (!candidate.capabilityMap.mutation.narrowingAppliesImmediately) {
    reasons.push(reason("narrowing_immediate_disabled"));
  }

  const expiryReason = classifyExpiry(candidate, policy);
  if (expiryReason) reasons.push(reason(expiryReason));

  return reasons.length === 0 ? { kind: "inside", reasons: [] } : { kind: "outside", reasons };
}

export function validateRotationOverlap(
  overlap: TokenRotationOverlap,
  policy: GlobalTokenProfilePolicy
): { kind: "allowed" } | { kind: "blocked"; code: "rotation_overlap_exceeds_maximum"; message: string; reasons: GlobalPolicyReason[] } {
  if (rotationOverlapMinutes(overlap) <= rotationOverlapMinutes(policy.mutation.maxRotationOverlap)) return { kind: "allowed" };
  return {
    kind: "blocked",
    code: "rotation_overlap_exceeds_maximum",
    message: "Requested rotation overlap exceeds the Global Token profile policy.",
    reasons: [reason("rotation_overlap_exceeds_maximum")]
  };
}

export function parseGlobalTokenProfilePolicy(value: unknown): { kind: "valid"; policy: GlobalTokenProfilePolicy } | { kind: "invalid"; message: string } {
  if (!isRecord(value)) return invalid("Global Token profile policy must be an object.");
  if (unsupportedPolicyKeys(value).length > 0) return invalid("Global Token profile policy contains unsupported fields.");
  if (value.version !== 1) return invalid("Global Token profile policy version is unsupported.");

  const presets = parseEnumSection(value.presets, PRESETS, "presets");
  if (!presets) return invalid("Global Token profile policy presets are invalid.");
  const executionIdentities = parseEnumSection(value.executionIdentities, EXECUTION_IDENTITIES, "execution identities");
  if (!executionIdentities) return invalid("Global Token profile policy execution identities are invalid.");

  const capabilities = parseCapabilities(value.capabilities);
  if (!capabilities) return invalid("Global Token profile policy capabilities are invalid.");

  const expiry = parseExpiry(value.expiry);
  if (!expiry) return invalid("Global Token profile policy expiry settings are invalid.");

  const mutation = parseMutation(value.mutation);
  if (!mutation) return invalid("Global Token profile policy mutation settings are invalid.");

  const policy: GlobalTokenProfilePolicy = {
    version: 1,
    presets: presets as GlobalTokenProfilePolicy["presets"],
    executionIdentities: executionIdentities as GlobalTokenProfilePolicy["executionIdentities"],
    capabilities,
    expiry,
    mutation
  };

  if (classifyCapabilityLimits(policy.capabilities.defaults, policy.capabilities.maximum).length > 0) {
    return invalid("Global Token profile policy defaults exceed maximums.");
  }
  if (!policy.presets.allowed.includes(policy.presets.default)) return invalid("Global Token profile policy default preset is not allowed.");
  if (!policy.executionIdentities.allowed.includes(policy.executionIdentities.default)) return invalid("Global Token profile policy default execution identity is not allowed.");
  if (policy.expiry.defaultExperimentTtl && !policy.expiry.allowedExperimentTtls.includes(policy.expiry.defaultExperimentTtl)) {
    return invalid("Global Token profile policy default experiment TTL is not allowed.");
  }

  return { kind: "valid", policy };
}

function classifyExpiry(candidate: TokenProfilePolicyCandidate, policy: GlobalTokenProfilePolicy): GlobalPolicyReasonCode | null {
  if (candidate.expiresAt === null) {
    // Allow no expiry for read-only when explicitly allowed
    if (candidate.preset === "read_only" && policy.expiry.allowNoExpiryForReadOnly) return null;
    // Allow no expiry for non-destructive tokens
    if (!candidate.capabilityMap.actions.destructive) return null;
    // Destructive tokens must have expiry
    return "no_expiry_disallowed";
  }

  const maximumDays = candidate.capabilityMap.actions.destructive
    ? policy.expiry.maximumDays.destructive
    : candidate.preset === "read_only"
      ? policy.expiry.maximumDays.readOnly
      : policy.expiry.maximumDays.nonDestructive;

  if (maximumDays === null) return null;
  return Math.ceil((candidate.expiresAt.getTime() - candidate.policyEffectiveAt.getTime()) / DAY_MS) > maximumDays ? "expiry_exceeds_maximum" : null;
}

function classifyCapabilityLimits(defaults: CapabilityLimits, maximum: CapabilityLimits): GlobalPolicyReason[] {
  const reasons: GlobalPolicyReason[] = [];
  for (const key of Object.keys(defaults.actions) as Array<keyof CapabilityMap["actions"]>) {
    if (defaults.actions[key] && !maximum.actions[key]) reasons.push(reason(actionReasonCode(key)));
  }
  const surfaceKeys: Array<keyof CapabilityMap["surfaces"]> = ["publicChannels", "privateChannels", "directMessages", "groupDirectMessages", "search", "filesMetadata"];
  for (const key of surfaceKeys) {
    if (defaults.surfaces[key] && !maximum.surfaces[key]) reasons.push(reason(surfaceReasonCode(key)));
  }
  return reasons;
}

function parseCapabilities(value: unknown): GlobalTokenProfilePolicy["capabilities"] | null {
  if (!isRecord(value)) return null;
  const defaults = parseCapabilityLimits(value.defaults);
  const maximum = parseCapabilityLimits(value.maximum);
  if (!defaults || !maximum) return null;
  return { defaults, maximum };
}

function parseCapabilityLimits(value: unknown): CapabilityLimits | null {
  if (!isRecord(value)) return null;
  const actions = parseActions(value.actions);
  const surfaces = parseSurfaces(value.surfaces);
  return actions && surfaces ? { actions, surfaces } : null;
}

function parseActions(value: unknown): CapabilityMap["actions"] | null {
  if (!isRecord(value)) return null;
  const read = value.read;
  const search = value.search;
  const writeMessages = value.writeMessages;
  const reactions = value.reactions;
  const filesMetadata = value.filesMetadata;
  const destructive = value.destructive;
  if (
    typeof read !== "boolean" ||
    typeof search !== "boolean" ||
    typeof writeMessages !== "boolean" ||
    typeof reactions !== "boolean" ||
    typeof filesMetadata !== "boolean" ||
    typeof destructive !== "boolean"
  ) {
    return null;
  }
  return { read, search, writeMessages, reactions, filesMetadata, destructive };
}

function parseSurfaces(value: unknown): CapabilityMap["surfaces"] | null {
  if (!isRecord(value)) return null;
  const publicChannels = value.publicChannels;
  const privateChannels = value.privateChannels;
  const directMessages = value.directMessages;
  const groupDirectMessages = value.groupDirectMessages;
  const search = value.search;
  const filesMetadata = value.filesMetadata;
  if (
    typeof publicChannels !== "boolean" ||
    typeof privateChannels !== "boolean" ||
    typeof directMessages !== "boolean" ||
    typeof groupDirectMessages !== "boolean" ||
    typeof search !== "boolean" ||
    typeof filesMetadata !== "boolean"
  ) {
    return null;
  }
  return {
    publicChannels,
    privateChannels,
    directMessages,
    groupDirectMessages,
    search,
    filesMetadata,
    canvases: false,
    lists: false,
    future: false
  };
}

function parseEnumSection<T extends string>(value: unknown, allowedValues: T[], label: string): { allowed: T[]; default: T } | null {
  if (!isRecord(value) || !Array.isArray(value.allowed) || value.allowed.length === 0 || typeof value.default !== "string") return null;
  const allowed = value.allowed.filter((item): item is T => typeof item === "string" && allowedValues.includes(item as T));
  if (allowed.length !== value.allowed.length || !allowed.includes(value.default as T)) return null;
  const unique = [...new Set(allowed)];
  return unique.length > 0 ? { allowed: unique, default: value.default as T } : null;
}

function parseExpiry(value: unknown): GlobalTokenProfilePolicy["expiry"] | null {
  if (!isRecord(value) || !isRecord(value.maximumDays) || typeof value.allowNoExpiryForReadOnly !== "boolean" || !Array.isArray(value.allowedExperimentTtls)) return null;
  const readOnly = value.maximumDays.readOnly;
  const nonDestructive = value.maximumDays.nonDestructive;
  const destructive = value.maximumDays.destructive;
  if (!(readOnly === null || isPositiveInteger(readOnly)) || !(nonDestructive === null || isPositiveInteger(nonDestructive)) || !isPositiveInteger(destructive)) return null;
  const allowedExperimentTtls = value.allowedExperimentTtls.filter((item): item is ExperimentTtl => typeof item === "string" && EXPERIMENT_TTLS.includes(item as ExperimentTtl));
  if (allowedExperimentTtls.length !== value.allowedExperimentTtls.length) return null;
  if (!(value.defaultExperimentTtl === null || EXPERIMENT_TTLS.includes(value.defaultExperimentTtl as ExperimentTtl))) return null;
  return {
    allowNoExpiryForReadOnly: value.allowNoExpiryForReadOnly,
    maximumDays: { readOnly: readOnly as number | null, nonDestructive: nonDestructive as number | null, destructive: destructive as number },
    allowedExperimentTtls: [...new Set(allowedExperimentTtls)],
    defaultExperimentTtl: value.defaultExperimentTtl as ExperimentTtl | null
  };
}

function parseMutation(value: unknown): GlobalTokenProfilePolicy["mutation"] | null {
  if (!isRecord(value)) return null;
  if (value.broadeningRequiresRotation !== true || value.narrowingAppliesImmediately !== true) return null;
  if (!ROTATION_OVERLAPS.includes(value.maxRotationOverlap as TokenRotationOverlap)) return null;
  return { broadeningRequiresRotation: true, narrowingAppliesImmediately: true, maxRotationOverlap: value.maxRotationOverlap as TokenRotationOverlap };
}

function unsupportedPolicyKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => !["version", "presets", "executionIdentities", "capabilities", "expiry", "mutation"].includes(key));
}

function actionReasonCode(key: keyof CapabilityMap["actions"]): GlobalPolicyReasonCode {
  if (key === "writeMessages") return "action_write_messages_exceeds_maximum";
  if (key === "filesMetadata") return "action_files_metadata_exceeds_maximum";
  return `action_${key.toLocaleLowerCase()}_exceeds_maximum` as GlobalPolicyReasonCode;
}

function surfaceReasonCode(key: keyof CapabilityMap["surfaces"]): GlobalPolicyReasonCode {
  if (key === "publicChannels") return "surface_public_channels_exceeds_maximum";
  if (key === "privateChannels") return "surface_private_channels_exceeds_maximum";
  if (key === "directMessages") return "surface_direct_messages_exceeds_maximum";
  if (key === "groupDirectMessages") return "surface_group_direct_messages_exceeds_maximum";
  if (key === "filesMetadata") return "surface_files_metadata_exceeds_maximum";
  return "surface_search_exceeds_maximum";
}

function reason(code: GlobalPolicyReasonCode): GlobalPolicyReason {
  return { code, message: reasonMessage(code) };
}

function reasonMessage(code: GlobalPolicyReasonCode): string {
  switch (code) {
    case "preset_disallowed":
      return "The preset is not allowed by the Global Token profile policy.";
    case "execution_identity_disallowed":
      return "The execution identity is not allowed by the Global Token profile policy.";
    case "action_read_exceeds_maximum":
      return "The read capability exceeds the Global Token profile policy maximum.";
    case "action_search_exceeds_maximum":
      return "The search capability exceeds the Global Token profile policy maximum.";
    case "action_write_messages_exceeds_maximum":
      return "The write messages capability exceeds the Global Token profile policy maximum.";
    case "action_reactions_exceeds_maximum":
      return "The reactions capability exceeds the Global Token profile policy maximum.";
    case "action_files_metadata_exceeds_maximum":
      return "The files metadata capability exceeds the Global Token profile policy maximum.";
    case "action_destructive_exceeds_maximum":
      return "The destructive capability exceeds the Global Token profile policy maximum.";
    case "surface_public_channels_exceeds_maximum":
      return "The public channels surface exceeds the Global Token profile policy maximum.";
    case "surface_private_channels_exceeds_maximum":
      return "The private channels surface exceeds the Global Token profile policy maximum.";
    case "surface_direct_messages_exceeds_maximum":
      return "The direct messages surface exceeds the Global Token profile policy maximum.";
    case "surface_group_direct_messages_exceeds_maximum":
      return "The group direct messages surface exceeds the Global Token profile policy maximum.";
    case "surface_search_exceeds_maximum":
      return "The search surface exceeds the Global Token profile policy maximum.";
    case "surface_files_metadata_exceeds_maximum":
      return "The files metadata surface exceeds the Global Token profile policy maximum.";
    case "experiment_ttl_disallowed":
      return "The experiment TTL is not allowed by the Global Token profile policy.";
    case "no_expiry_disallowed":
      return "A no-expiry Token profile is not allowed by the Global Token profile policy.";
    case "expiry_exceeds_maximum":
      return "The Token profile expiry exceeds the Global Token profile policy maximum.";
    case "broadening_requires_rotation_disabled":
      return "The Token profile does not require rotation for broadening.";
    case "narrowing_immediate_disabled":
      return "The Token profile does not apply narrowing immediately.";
    case "rotation_overlap_exceeds_maximum":
      return "The rotation overlap exceeds the Global Token profile policy maximum.";
  }
}

function rotationOverlapMinutes(overlap: TokenRotationOverlap): number {
  if (overlap === "15m") return 15;
  if (overlap === "1h") return 60;
  if (overlap === "24h") return 24 * 60;
  return 0;
}

function allBooleans(value: Record<string, unknown>): value is Record<string, boolean> {
  return Object.values(value).every((item) => typeof item === "boolean");
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 3650;
}

function invalid(message: string): { kind: "invalid"; message: string } {
  return { kind: "invalid", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
