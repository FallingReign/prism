import type { TokenProfileMetadata } from "../src/server/token-profiles/service";
import type { TokenProfileCapabilitySelection } from "./token-profile-policy-options";

export type TokenProfileSummary = {
  id: string;
  name: string;
  intendedUse: string;
  preset: "read_only" | "messages_only" | "full_slack_bridge" | "custom";
  executionIdentity: "user" | "bot" | "automatic" | "selectable";
  expiresAt: string | null;
  status?: "active" | "revoked";
  globalPolicyStatus?: {
    kind: "inside" | "outside";
    reasons: Array<{ code: string; message: string }>;
  };
  capabilities: TokenProfileCapabilitySelection;
  createdAt: string;
  developerToken?: {
    status: "active" | "expired" | "revoked" | "missing";
    createdAt?: string | null;
    expiresAt?: string | null;
    lastUsedAt?: string | null;
    revokedAt?: string | null;
    overlapExpiresAt?: string | null;
  };
};

export function toTokenProfileSummary(profile: TokenProfileMetadata): TokenProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    intendedUse: profile.intendedUse,
    preset: profile.preset,
    executionIdentity: profile.capabilityMap.executionIdentity,
    expiresAt: profile.expiresAt?.toISOString() ?? null,
    status: profile.status,
    globalPolicyStatus: profile.globalPolicyStatus,
    capabilities: { ...profile.capabilityMap.actions },
    createdAt: profile.createdAt.toISOString(),
    developerToken: profile.developerToken
      ? {
          status: profile.developerToken.status,
          createdAt: profile.developerToken.createdAt?.toISOString() ?? null,
          expiresAt: profile.developerToken.expiresAt?.toISOString() ?? null,
          lastUsedAt: profile.developerToken.lastUsedAt?.toISOString() ?? null,
          revokedAt: profile.developerToken.revokedAt?.toISOString() ?? null,
          overlapExpiresAt: profile.developerToken.overlapExpiresAt?.toISOString() ?? null
        }
      : undefined
  };
}
