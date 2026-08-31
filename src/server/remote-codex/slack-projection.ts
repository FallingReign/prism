import "server-only";

import type { SlackCatalogSession } from "./slack-catalog";

type SlackBlock = {
  type: string;
  text?: { type: string; text: string };
  accessory?: { type: string; action_id: string; text: { type: string; text: string }; value?: string; url?: string };
};

export type SlackHomeView = {
  type: "home";
  blocks: SlackBlock[];
};

export function buildRemoteCodexHomeView({
  sessions,
  connectUrl
}: {
  sessions: SlackCatalogSession[];
  connectUrl?: string;
}): SlackHomeView {
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: "Your Codex sessions" } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: sessions.length
          ? "Choose an existing session to create or reopen its private Slack thread."
          : "Connect Prism Companion on your computer, then your existing Codex sessions will appear here."
      },
      ...(sessions.length || !connectUrl
        ? {}
        : {
            accessory: {
              type: "button",
              action_id: "remote_codex_connect_computer",
              text: { type: "plain_text", text: "Connect your computer" },
              url: connectUrl
            }
          })
    }
  ];

  for (const session of sessions.slice(0, 10)) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${slackText(session.title)}*\n\`${slackText(session.projectLabel)}\` · ${slackText(session.machineLabel)} · ${statusLabel(session.status)}`
      },
      accessory: {
        type: "button",
        action_id: "remote_codex_share_session",
        text: { type: "plain_text", text: "Attach to Slack" },
        value: encodeSessionAction({ installationId: session.installationId, threadId: session.threadId })
      }
    });
  }
  return { type: "home", blocks };
}

export function decodeSessionAction(value: string): { installationId: string; threadId: string } | null {
  try {
    if (!/^[A-Za-z0-9_-]{8,400}$/.test(value)) return null;
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(parsed) || Object.keys(parsed).sort().join(",") !== "installationId,threadId") return null;
    if (typeof parsed.installationId !== "string" || !/^rc_install_[A-Za-z0-9_-]{1,100}$/.test(parsed.installationId)) return null;
    if (typeof parsed.threadId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.threadId)) return null;
    return { installationId: parsed.installationId, threadId: parsed.threadId };
  } catch {
    return null;
  }
}

function encodeSessionAction(value: { installationId: string; threadId: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function slackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function statusLabel(status: SlackCatalogSession["status"]): string {
  if (status === "active") return "In progress on computer";
  if (status === "attention") return "Needs attention";
  return "Ready";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
