import type { TokenProfileSummary } from "./token-profile-summary";

type SlackStatus = "healthy" | "reauth_required";
type AccessTone = "success" | "warning" | "neutral";

export type AccessStatus = {
  label: string;
  tone: AccessTone;
};

export function accessStatusForProfile(profile: TokenProfileSummary, slackStatus: SlackStatus): AccessStatus {
  const developerTokenStatus = profile.developerToken?.status ?? "missing";
  if (profile.status === "revoked" || developerTokenStatus === "revoked") return { label: "Removed", tone: "neutral" };
  if (developerTokenStatus === "expired") return { label: "Expired", tone: "warning" };
  if (developerTokenStatus === "missing") return { label: "No active token", tone: "warning" };
  if (slackStatus === "reauth_required") return { label: "Needs Slack reauth", tone: "warning" };
  return { label: "Ready", tone: "success" };
}

export function managerTokenProfiles(profiles: TokenProfileSummary[]): TokenProfileSummary[] {
  return profiles;
}

export function isInactiveTokenProfile(profile: TokenProfileSummary): boolean {
  return profile.status === "revoked" || profile.developerToken?.status === "revoked" || profile.developerToken?.status === "expired" || profile.developerToken?.status === "missing";
}

export function hasUsableDeveloperToken(profile: TokenProfileSummary): boolean {
  return profile.status !== "revoked" && profile.developerToken?.status === "active";
}
