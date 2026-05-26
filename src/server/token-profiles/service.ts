import "server-only";

import type { DeveloperTokenConfig, DeveloperTokenVerifier } from "./developer-token";
import { hashDeveloperToken, issueDeveloperToken } from "./developer-token";
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

export async function createTokenProfile({
  store,
  sessionToken,
  developerTokenConfig,
  input,
  audit,
  now = new Date(),
  randomBytes
}: {
  store: TokenProfileStore;
  sessionToken: string | undefined;
  developerTokenConfig: DeveloperTokenConfig;
  input: CreateTokenProfileInput;
  audit?: { endpoint: string; requestId: string };
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<
  | { kind: "created"; profile: TokenProfileMetadata; developerToken: string; slackStatus: TokenProfileOwner["slackStatus"] }
  | { kind: "unauthenticated" | "not_linked" | "duplicate_name" }
  | { kind: "validation_error"; message: string }
> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;

  const parsed = validateInput(input);
  if (parsed.kind === "validation_error") return parsed;

  const policy = buildTokenProfilePolicy(parsed.input, now);
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
  return { kind: "created", profile: result.profile, developerToken, slackStatus: owner.owner.slackStatus };
}

export async function listTokenProfiles({
  store,
  sessionToken,
  now = new Date()
}: {
  store: TokenProfileStore;
  sessionToken: string | undefined;
  now?: Date;
}): Promise<
  { kind: "profiles"; owner: TokenProfileOwner; profiles: TokenProfileMetadata[]; slackStatus: TokenProfileOwner["slackStatus"] } | { kind: "unauthenticated" | "not_linked" }
> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;
  return { kind: "profiles", owner: owner.owner, profiles: await store.listProfiles(owner.owner), slackStatus: owner.owner.slackStatus };
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
  sessionToken,
  profileId,
  overlap,
  developerTokenConfig,
  audit,
  now = new Date(),
  randomBytes
}: {
  store: TokenProfileStore;
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
> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;
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
  return { kind: "rotated", profile: result.profile, developerToken, slackStatus: owner.owner.slackStatus };
}

export async function updateTokenProfilePolicy({
  store,
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
  | { kind: "unauthenticated" | "not_linked" | "not_found" }
> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;
  const parsed = validateInput(input);
  if (parsed.kind === "validation_error") return parsed;
  const currentProfiles = await store.listProfiles(owner.owner);
  const current = currentProfiles.find((profile) => profile.id === profileId);
  if (!current) return { kind: "not_found" };

  const nextPolicy = buildTokenProfilePolicy(parsed.input, now);
  const change = classifyPolicyChange(current.capabilityMap, current.expiresAt, nextPolicy.capabilityMap, nextPolicy.expiresAt);
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
    now,
    rotation,
    audit
  });
  if (result.kind === "not_found") return result;
  return { kind: "updated", change, profile: result.profile, developerToken, slackStatus: owner.owner.slackStatus };
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
