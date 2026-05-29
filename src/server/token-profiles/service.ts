import "server-only";

import type { DeveloperTokenConfig, DeveloperTokenVerifier } from "./developer-token";
import { hashDeveloperToken, issueDeveloperToken } from "./developer-token";
import {
  applyGlobalTokenProfilePolicyDefaults,
  buildCurrentGlobalTokenProfilePolicy,
  classifyGlobalTokenProfilePolicyStatus,
  validateRequestedTokenProfilePolicy,
  validateRotationOverlap,
  type GlobalPolicyReason,
  type GlobalPolicyStatus,
  type GlobalTokenProfilePolicy
} from "./global-policy";
import type { GlobalTokenProfilePolicyStore } from "./global-policy-store";
import { buildTokenProfilePolicy, type CapabilityMap, type ExecutionIdentity, type ExperimentTtl, type TokenProfilePreset } from "./presets";

export type CreateTokenProfileInput = {
  name: string;
  intendedUse: string;
  preset: TokenProfilePreset;
  executionIdentity: ExecutionIdentity;
  destructive?: boolean;
  experiment?: ExperimentTtl;
  custom?: {
    read?: boolean;
    search?: boolean;
    writeMessages?: boolean;
    reactions?: boolean;
    filesMetadata?: boolean;
    destructive?: boolean;
  };
};

export type TokenRotationOverlap = "none" | "15m" | "1h" | "24h";

export type TokenProfileMetadata = {
  id: string;
  prismUserId: string;
  slackConnectionId: string;
  name: string;
  nameNormalized: string;
  intendedUse: string;
  preset: TokenProfilePreset;
  capabilityMap: CapabilityMap;
  expiresAt: Date | null;
  status: "active" | "revoked";
  developerToken?: TokenProfileDeveloperTokenMetadata;
  globalPolicyStatus: GlobalPolicyStatus;
  policyEffectiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type TokenProfileDeveloperTokenMetadata = {
  status: "active" | "expired" | "revoked" | "missing";
  createdAt?: Date | null;
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  overlapExpiresAt?: Date | null;
};

export type TokenProfileOwner = {
  prismUserId: string;
  slackConnectionId: string;
  slackStatus: "healthy" | "reauth_required";
};

export type TokenProfileStore = {
  resolveOwner(input: { sessionToken: string; now: Date }): Promise<TokenProfileOwner | null>;
  listProfiles(owner: TokenProfileOwner): Promise<TokenProfileMetadata[]>;
  insertProfileWithVerifier(input: {
    prismUserId: string;
    slackConnectionId: string;
    name: string;
    nameNormalized: string;
    intendedUse: string;
    preset: TokenProfilePreset;
    capabilityMap: CapabilityMap;
    expiresAt: Date | null;
    status: "active";
    verifier: DeveloperTokenVerifier;
    audit?: { endpoint: string; requestId: string };
  }): Promise<{ kind: "created"; profile: TokenProfileMetadata } | { kind: "duplicate_name" }>;
  revokeProfileDeveloperTokens(input: {
    prismUserId: string;
    slackConnectionId: string;
    profileId: string;
    now: Date;
    audit?: { endpoint: string; requestId: string };
  }): Promise<{ kind: "revoked"; profile: TokenProfileMetadata } | { kind: "not_found" }>;
  rotateProfileDeveloperToken(input: {
    prismUserId: string;
    slackConnectionId: string;
    profileId: string;
    verifier: DeveloperTokenVerifier;
    overlap: TokenRotationOverlap;
    overlapExpiresAt: Date | null;
    now: Date;
    audit?: { endpoint: string; requestId: string };
  }): Promise<{ kind: "rotated"; profile: TokenProfileMetadata } | { kind: "not_found" }>;
  updateProfilePolicy(input: {
    prismUserId: string;
    slackConnectionId: string;
    profileId: string;
    preset: TokenProfilePreset;
    capabilityMap: CapabilityMap;
    expiresAt: Date | null;
    policyEffectiveAt: Date;
    now: Date;
    rotation?: { verifier: DeveloperTokenVerifier };
    audit?: { endpoint: string; requestId: string };
  }): Promise<{ kind: "updated"; profile: TokenProfileMetadata } | { kind: "not_found" }>;
  deleteInactiveProfile(input: {
    prismUserId: string;
    slackConnectionId: string;
    profileId: string;
    now: Date;
    audit?: { endpoint: string; requestId: string };
  }): Promise<{ kind: "deleted"; profile: TokenProfileMetadata } | { kind: "not_found" | "conflict" }>;
};

type GlobalPolicyReader = Pick<GlobalTokenProfilePolicyStore, "readGlobalTokenProfilePolicy">;

export async function createTokenProfile({
  store,
  globalPolicyStore,
  sessionToken,
  developerTokenConfig,
  input,
  audit,
  now = new Date(),
  randomBytes
}: {
  store: TokenProfileStore;
  globalPolicyStore?: GlobalPolicyReader;
  sessionToken: string | undefined;
  developerTokenConfig: DeveloperTokenConfig;
  input: CreateTokenProfileInput;
  audit?: { endpoint: string; requestId: string };
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<
  | { kind: "created"; profile: TokenProfileMetadata; developerToken: string; slackStatus: TokenProfileOwner["slackStatus"] }
  | { kind: "unauthenticated" | "not_linked" | "duplicate_name" }
  | { kind: "global_policy_violation"; message: string; reasons: GlobalPolicyReason[] }
  | { kind: "validation_error"; message: string }
> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;

  const globalPolicy = await readGlobalPolicy(globalPolicyStore);
  const parsed = validateInput(applyGlobalTokenProfilePolicyDefaults(input, globalPolicy));
  if (parsed.kind === "validation_error") return parsed;

  const policy = buildTokenProfilePolicy(parsed.input, now);
  const globalValidation = validateRequestedTokenProfilePolicy({
    input: parsed.input,
    capabilityMap: policy.capabilityMap,
    expiresAt: policy.expiresAt,
    policyEffectiveAt: now,
    policy: globalPolicy
  });
  if (globalValidation.kind === "blocked") {
    return { kind: globalValidation.code, message: globalValidation.message, reasons: globalValidation.reasons };
  }

  const developerToken = issueDeveloperToken({ randomBytes });
  const verifier = hashDeveloperToken(developerToken, developerTokenConfig);
  const result = await store.insertProfileWithVerifier({
    prismUserId: owner.owner.prismUserId,
    slackConnectionId: owner.owner.slackConnectionId,
    name: parsed.input.name.trim(),
    nameNormalized: normalizeName(parsed.input.name),
    intendedUse: parsed.input.intendedUse.trim(),
    preset: parsed.input.preset,
    capabilityMap: policy.capabilityMap,
    expiresAt: policy.expiresAt,
    status: "active",
    verifier,
    audit
  });

  if (result.kind === "duplicate_name") return { kind: "duplicate_name" };
  return { kind: "created", profile: withGlobalPolicyStatus(result.profile, globalPolicy), developerToken, slackStatus: owner.owner.slackStatus };
}

export async function listTokenProfiles({
  store,
  globalPolicyStore,
  sessionToken,
  now = new Date()
}: {
  store: TokenProfileStore;
  globalPolicyStore?: GlobalPolicyReader;
  sessionToken: string | undefined;
  now?: Date;
}): Promise<
  { kind: "profiles"; owner: TokenProfileOwner; profiles: TokenProfileMetadata[]; slackStatus: TokenProfileOwner["slackStatus"] } | { kind: "unauthenticated" | "not_linked" }
> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;
  const globalPolicy = await readGlobalPolicy(globalPolicyStore);
  return {
    kind: "profiles",
    owner: owner.owner,
    profiles: (await store.listProfiles(owner.owner)).map((profile) => withGlobalPolicyStatus(profile, globalPolicy)),
    slackStatus: owner.owner.slackStatus
  };
}

export async function revokeTokenProfile({
  store,
  sessionToken,
  profileId,
  audit,
  now = new Date()
}: {
  store: TokenProfileStore;
  sessionToken: string | undefined;
  profileId: string;
  audit?: { endpoint: string; requestId: string };
  now?: Date;
}): Promise<{ kind: "revoked"; profile: TokenProfileMetadata; slackStatus: TokenProfileOwner["slackStatus"] } | { kind: "unauthenticated" | "not_linked" | "not_found" }> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;
  const result = await store.revokeProfileDeveloperTokens({
    prismUserId: owner.owner.prismUserId,
    slackConnectionId: owner.owner.slackConnectionId,
    profileId,
    now,
    audit
  });
  if (result.kind === "not_found") return result;
  return { kind: "revoked", profile: result.profile, slackStatus: owner.owner.slackStatus };
}

export async function deleteTokenProfile({
  store,
  sessionToken,
  profileId,
  audit,
  now = new Date()
}: {
  store: TokenProfileStore;
  sessionToken: string | undefined;
  profileId: string;
  audit?: { endpoint: string; requestId: string };
  now?: Date;
}): Promise<{ kind: "deleted"; profile: TokenProfileMetadata; slackStatus: TokenProfileOwner["slackStatus"] } | { kind: "unauthenticated" | "not_linked" | "not_found" | "conflict" }> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;
  const result = await store.deleteInactiveProfile({
    prismUserId: owner.owner.prismUserId,
    slackConnectionId: owner.owner.slackConnectionId,
    profileId,
    now,
    audit
  });
  if (result.kind !== "deleted") return result;
  return { kind: "deleted", profile: result.profile, slackStatus: owner.owner.slackStatus };
}

export async function rotateTokenProfile({
  store,
  globalPolicyStore,
  sessionToken,
  profileId,
  overlap,
  developerTokenConfig,
  audit,
  now = new Date(),
  randomBytes
}: {
  store: TokenProfileStore;
  globalPolicyStore?: GlobalPolicyReader;
  sessionToken: string | undefined;
  profileId: string;
  overlap: TokenRotationOverlap;
  developerTokenConfig: DeveloperTokenConfig;
  audit?: { endpoint: string; requestId: string };
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<
  | { kind: "rotated"; profile: TokenProfileMetadata; developerToken: string; slackStatus: TokenProfileOwner["slackStatus"] }
  | { kind: "unauthenticated" | "not_linked" | "not_found" | "validation_error"; message?: string }
  | { kind: "outside_global_policy"; message: string; reasons: GlobalPolicyReason[] }
> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;
  const globalPolicy = await readGlobalPolicy(globalPolicyStore);
  const current = (await store.listProfiles(owner.owner)).find((profile) => profile.id === profileId);
  if (!current || current.status !== "active") return { kind: "not_found" };
  const currentGlobalStatus = classifyGlobalTokenProfilePolicyStatus(toGlobalPolicyCandidate(current), globalPolicy);
  if (currentGlobalStatus.kind === "outside") return outsideGlobalPolicyBlocked(currentGlobalStatus.reasons);
  const overlapValidation = validateRotationOverlap(overlap, globalPolicy);
  if (overlapValidation.kind === "blocked") return { kind: "validation_error", message: overlapValidation.message };

  const overlapExpiresAt = rotationOverlapExpiresAt(overlap, now);
  const developerToken = issueDeveloperToken({ randomBytes });
  const verifier = hashDeveloperToken(developerToken, developerTokenConfig);
  const result = await store.rotateProfileDeveloperToken({
    prismUserId: owner.owner.prismUserId,
    slackConnectionId: owner.owner.slackConnectionId,
    profileId,
    verifier,
    overlap,
    overlapExpiresAt,
    now,
    audit
  });
  if (result.kind === "not_found") return result;
  return { kind: "rotated", profile: withGlobalPolicyStatus(result.profile, globalPolicy), developerToken, slackStatus: owner.owner.slackStatus };
}

export async function updateTokenProfilePolicy({
  store,
  globalPolicyStore,
  sessionToken,
  profileId,
  input,
  confirmBroadening = false,
  developerTokenConfig,
  audit,
  now = new Date(),
  randomBytes
}: {
  store: TokenProfileStore;
  globalPolicyStore?: GlobalPolicyReader;
  sessionToken: string | undefined;
  profileId: string;
  input: CreateTokenProfileInput;
  confirmBroadening?: boolean;
  developerTokenConfig?: DeveloperTokenConfig;
  audit?: { endpoint: string; requestId: string };
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<
  | { kind: "updated"; change: "narrowing" | "broadening" | "unchanged"; profile: TokenProfileMetadata; developerToken?: string; slackStatus: TokenProfileOwner["slackStatus"] }
  | { kind: "rotation_required"; change: "broadening"; message: string }
  | { kind: "validation_error"; message: string }
  | { kind: "global_policy_violation"; message: string; reasons: GlobalPolicyReason[] }
  | { kind: "outside_global_policy"; message: string; reasons: GlobalPolicyReason[] }
  | { kind: "unauthenticated" | "not_linked" | "not_found" }
> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;
  const globalPolicy = await readGlobalPolicy(globalPolicyStore);
  const parsed = validateInput(applyGlobalTokenProfilePolicyDefaults(input, globalPolicy));
  if (parsed.kind === "validation_error") return parsed;
  const currentProfiles = await store.listProfiles(owner.owner);
  const current = currentProfiles.find((profile) => profile.id === profileId);
  if (!current) return { kind: "not_found" };

  const nextPolicy = buildTokenProfilePolicy(parsed.input, now);
  const change = classifyPolicyChange(current.capabilityMap, current.expiresAt, nextPolicy.capabilityMap, nextPolicy.expiresAt);
  const currentGlobalStatus = classifyGlobalTokenProfilePolicyStatus(toGlobalPolicyCandidate(current), globalPolicy);
  if (currentGlobalStatus.kind === "outside") {
    if (change !== "narrowing") {
      return outsideGlobalPolicyBlocked(currentGlobalStatus.reasons);
    }
  } else {
    const nextGlobalValidation = validateRequestedTokenProfilePolicy({
      input: parsed.input,
      capabilityMap: nextPolicy.capabilityMap,
      expiresAt: nextPolicy.expiresAt,
      policyEffectiveAt: now,
      policy: globalPolicy
    });
    if (nextGlobalValidation.kind === "blocked") {
      return { kind: nextGlobalValidation.code, message: nextGlobalValidation.message, reasons: nextGlobalValidation.reasons };
    }
  }
  if (change === "broadening" && !confirmBroadening) {
    return { kind: "rotation_required", change, message: "Capability broadening requires token rotation." };
  }

  const developerToken = change === "broadening" ? issueDeveloperToken({ randomBytes }) : undefined;
  const rotation = developerToken && developerTokenConfig ? { verifier: hashDeveloperToken(developerToken, developerTokenConfig) } : undefined;
  if (change === "broadening" && !rotation) {
    return { kind: "validation_error", message: "Capability broadening requires developer token rotation configuration." };
  }

  const result = await store.updateProfilePolicy({
    prismUserId: owner.owner.prismUserId,
    slackConnectionId: owner.owner.slackConnectionId,
    profileId,
    preset: parsed.input.preset,
    capabilityMap: nextPolicy.capabilityMap,
    expiresAt: nextPolicy.expiresAt,
    policyEffectiveAt: sameDateTime(current.expiresAt, nextPolicy.expiresAt) ? current.policyEffectiveAt : now,
    now,
    rotation,
    audit
  });
  if (result.kind === "not_found") return result;
  return { kind: "updated", change, profile: withGlobalPolicyStatus(result.profile, globalPolicy), developerToken, slackStatus: owner.owner.slackStatus };
}

async function resolveOwner(
  store: TokenProfileStore,
  sessionToken: string | undefined,
  now: Date
): Promise<{ kind: "owner"; owner: TokenProfileOwner } | { kind: "unauthenticated" | "not_linked" }> {
  if (!sessionToken) return { kind: "unauthenticated" };
  const owner = await store.resolveOwner({ sessionToken, now });
  return owner ? { kind: "owner", owner } : { kind: "not_linked" };
}

function validateInput(input: CreateTokenProfileInput): { kind: "valid"; input: CreateTokenProfileInput } | { kind: "validation_error"; message: string } {
  const name = input.name?.trim();
  const intendedUse = input.intendedUse?.trim();
  if (!name || name.length > 80) return { kind: "validation_error", message: "Profile name must be 1-80 characters." };
  if (!intendedUse || intendedUse.length > 180) return { kind: "validation_error", message: "Intended use must be 1-180 characters." };
  if (!["read_only", "messages_only", "full_slack_bridge", "custom"].includes(input.preset)) {
    return { kind: "validation_error", message: "Choose a supported Token profile preset." };
  }
  if (!["user", "bot", "automatic", "selectable"].includes(input.executionIdentity)) {
    return { kind: "validation_error", message: "Choose a supported execution identity." };
  }
  if (input.experiment && !["24h", "7d"].includes(input.experiment)) {
    return { kind: "validation_error", message: "Choose a supported experiment expiry." };
  }
  return { kind: "valid", input: { ...input, name, intendedUse } };
}

async function readGlobalPolicy(store: GlobalPolicyReader | undefined): Promise<GlobalTokenProfilePolicy> {
  return store ? (await store.readGlobalTokenProfilePolicy()).policy : buildCurrentGlobalTokenProfilePolicy();
}

function withGlobalPolicyStatus(profile: TokenProfileMetadata, policy: GlobalTokenProfilePolicy): TokenProfileMetadata {
  return {
    ...profile,
    globalPolicyStatus: classifyGlobalTokenProfilePolicyStatus(toGlobalPolicyCandidate(profile), policy)
  };
}

function toGlobalPolicyCandidate(profile: TokenProfileMetadata) {
  return {
    preset: profile.preset,
    capabilityMap: profile.capabilityMap,
    expiresAt: profile.expiresAt,
    policyEffectiveAt: profile.policyEffectiveAt
  };
}

function outsideGlobalPolicyBlocked(reasons: GlobalPolicyReason[]): { kind: "outside_global_policy"; message: string; reasons: GlobalPolicyReason[] } {
  return {
    kind: "outside_global_policy",
    message: "Narrow this Token profile inside the Global Token profile policy before rotating or broadening it.",
    reasons
  };
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function rotationOverlapExpiresAt(overlap: TokenRotationOverlap, now: Date): Date | null {
  if (overlap === "none") return null;
  const minutes = overlap === "15m" ? 15 : overlap === "1h" ? 60 : 24 * 60;
  return new Date(now.getTime() + minutes * 60 * 1000);
}

function classifyPolicyChange(
  current: CapabilityMap,
  currentExpiresAt: Date | null,
  next: CapabilityMap,
  nextExpiresAt: Date | null
): "narrowing" | "broadening" | "unchanged" {
  let narrowed = false;
  let broadened = false;

  for (const key of Object.keys(current.actions) as Array<keyof CapabilityMap["actions"]>) {
    if (current.actions[key] && !next.actions[key]) narrowed = true;
    if (!current.actions[key] && next.actions[key]) broadened = true;
  }
  for (const key of Object.keys(current.surfaces) as Array<keyof CapabilityMap["surfaces"]>) {
    if (current.surfaces[key] && !next.surfaces[key]) narrowed = true;
    if (!current.surfaces[key] && next.surfaces[key]) broadened = true;
  }

  const identityChange = classifyExecutionIdentityChange(current.executionIdentity, next.executionIdentity);
  if (identityChange === "narrowing") narrowed = true;
  if (identityChange === "broadening") broadened = true;

  const expiryChange = classifyExpiryChange(currentExpiresAt, nextExpiresAt);
  if (expiryChange === "narrowing") narrowed = true;
  if (expiryChange === "broadening") broadened = true;

  if (broadened) return "broadening";
  if (narrowed) return "narrowing";
  return "unchanged";
}

function classifyExecutionIdentityChange(current: ExecutionIdentity, next: ExecutionIdentity): "narrowing" | "broadening" | "unchanged" {
  if (current === next) return "unchanged";
  const rank: Record<ExecutionIdentity, number> = { user: 1, bot: 1, automatic: 2, selectable: 3 };
  if (rank[next] < rank[current]) return "narrowing";
  return "broadening";
}

function classifyExpiryChange(current: Date | null, next: Date | null): "narrowing" | "broadening" | "unchanged" {
  if (current === null && next === null) return "unchanged";
  if (current === null) return "narrowing";
  if (next === null) return "broadening";
  if (next.getTime() < current.getTime()) return "narrowing";
  if (next.getTime() > current.getTime()) return "broadening";
  return "unchanged";
}

function sameDateTime(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}
