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
  status: "active";
  createdAt: Date;
  updatedAt: Date;
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
  }): Promise<{ kind: "created"; profile: TokenProfileMetadata } | { kind: "duplicate_name" }>;
};

export async function createTokenProfile({
  store,
  sessionToken,
  developerTokenConfig,
  input,
  now = new Date(),
  randomBytes
}: {
  store: TokenProfileStore;
  sessionToken: string | undefined;
  developerTokenConfig: DeveloperTokenConfig;
  input: CreateTokenProfileInput;
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
    verifier
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
}): Promise<{ kind: "profiles"; profiles: TokenProfileMetadata[]; slackStatus: TokenProfileOwner["slackStatus"] } | { kind: "unauthenticated" | "not_linked" }> {
  const owner = await resolveOwner(store, sessionToken, now);
  if (owner.kind !== "owner") return owner;
  return { kind: "profiles", profiles: await store.listProfiles(owner.owner), slackStatus: owner.owner.slackStatus };
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
