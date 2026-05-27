import type { SlackWebsiteStatus } from "./slack-status-panel";

export function slackScopeDisplay(status: Extract<SlackWebsiteStatus, { kind: "linked" }>): { label: "workspace" | "organization"; value: string } {
  if (status.teamId) return { label: "workspace", value: displayNameWithId(status.teamName, status.teamId) };
  return { label: "organization", value: displayNameWithId(status.enterpriseName, status.enterpriseId ?? "unknown") };
}

export function slackUserDisplay(status: Extract<SlackWebsiteStatus, { kind: "linked" }>): string {
  return displayNameWithId(status.slackUserDisplayName, status.slackUserId);
}

export function displayNameWithId(name: string | null | undefined, id: string): string {
  const safeId = safeConnectionText(id);
  const safeName = name ? safeConnectionText(name.trim()) : "";
  return safeName ? `${safeName} (${safeId})` : safeId;
}

export function safeConnectionText(value: string): string {
  return value
    .replace(/prism_dev_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/xox[a-z]-[A-Za-z0-9-]+/gi, "[redacted]")
    .replace(/access[_-]?token|client[_-]?secret|tokenHash|pepper|refresh[_-]?secret|authorization/gi, "[redacted]");
}
