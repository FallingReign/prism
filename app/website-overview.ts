import type { ActivityAuditSummary } from "../src/server/audit/presentation";
import { slackScopeDisplay, slackUserDisplay } from "./slack-connection-display";
import type { SlackWebsiteStatus } from "./slack-status-panel";
import type { TokenProfileSummary } from "./token-profile-summary";

type OverviewTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";

export type WebsiteOverviewItem = {
  label: string;
  value: string;
  detail: string;
  tone: OverviewTone;
};

export type WebsiteOverview = {
  slack: WebsiteOverviewItem;
  custody: WebsiteOverviewItem;
  tokenProfiles: WebsiteOverviewItem;
  activity: WebsiteOverviewItem;
};

export function buildWebsiteOverview(
  slackStatus: SlackWebsiteStatus,
  tokenProfiles: TokenProfileSummary[],
  activity: ActivityAuditSummary[]
): WebsiteOverview {
  const activeProfiles = tokenProfiles.filter((profile) => profile.developerToken?.status === "active").length;

  return {
    slack: buildSlackOverview(slackStatus),
    custody: {
      label: "Credential custody",
      value: "Server-held Slack credentials",
      detail: "Local tools receive opaque Prism developer tokens only.",
      tone: "primary"
    },
    tokenProfiles: {
      label: "Token profiles",
      value: activeProfiles === 1 ? "1 active" : `${activeProfiles} active`,
      detail:
        tokenProfiles.length === 0
          ? "No Token profiles yet"
          : `${tokenProfiles.length} total Token profile${tokenProfiles.length === 1 ? "" : "s"}`,
      tone: activeProfiles > 0 ? "success" : "neutral"
    },
    activity: {
      label: "Metadata audit",
      value: activity.length === 0 ? "No activity" : activity.length === 1 ? "1 recent event" : `${activity.length} recent events`,
      detail: "Methods, outcomes, objects, request IDs, and timestamps only.",
      tone: activity.length > 0 ? "info" : "neutral"
    }
  };
}

function buildSlackOverview(slackStatus: SlackWebsiteStatus): WebsiteOverviewItem {
  if (slackStatus.kind === "setup_required") {
    return {
      label: "Setup required",
      value: "Server configuration",
      detail: "Slack OAuth or credential encryption settings are missing.",
      tone: "warning"
    };
  }

  if (slackStatus.kind === "not_linked") {
    return {
      label: "Slack not linked",
      value: "Needs connection",
      detail: "Connect Slack before creating Prism developer tokens.",
      tone: "neutral"
    };
  }

  const scope = slackScopeDisplay(slackStatus);

  if (slackStatus.status === "reauth_required") {
    return {
      label: "Slack reauth required",
      value: "Reconnect needed",
      detail: `Slack user ${slackUserDisplay(slackStatus)} in ${scope.label} ${scope.value} must reconnect before Slack calls resume.`,
      tone: "warning"
    };
  }

  return {
    label: "Slack connected",
    value: "Linked",
    detail: `Slack user ${slackUserDisplay(slackStatus)} is connected to ${scope.label} ${scope.value}.`,
    tone: "success"
  };
}
