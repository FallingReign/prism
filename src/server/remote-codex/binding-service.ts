import "server-only";

export type OwnedRemoteCodexSession = {
  installationId: string;
  threadId: string;
  title: string;
  projectLabel: string;
  machineLabel: string;
  status: "ready" | "active" | "attention" | "unavailable";
  prismUserId: string;
  connectionId: string;
  teamId: string;
  slackUserId: string;
};

export type BindingRecord = {
  id: string;
  installationId: string;
  threadId: string;
  teamId: string;
  channelId: string | null;
  threadTs: string | null;
  state: "creating" | "active" | "failed" | "detached";
};

export type BindingStore = {
  findSlackOwnedSession(input: { teamId: string; slackUserId: string; appId: string; installationId: string; threadId: string }): Promise<OwnedRemoteCodexSession | null>;
  findRunnerOwnedSession(input: { prismUserId: string; slackConnectionId: string; installationId: string; threadId: string }): Promise<OwnedRemoteCodexSession | null>;
  reserve(session: OwnedRemoteCodexSession, now: Date): Promise<{ binding: BindingRecord; created: boolean }>;
  activate(input: { bindingId: string; channelId: string; threadTs: string; now: Date }): Promise<BindingRecord | null>;
  fail(bindingId: string, now: Date): Promise<void>;
};

type SlackCaller = {
  call(input: {
    ownerKey: string;
    connectionId: string;
    prismUserId: string;
    slackUserId: string;
    slackTeamId: string;
    method: string;
    payload: Record<string, unknown>;
    activityType: "remote_codex_binding_created";
    surface: "app_home" | "runner";
    objectType?: string;
    objectId?: string;
    requestId: string;
  }): Promise<{ kind: "ok"; body: unknown } | { kind: "unavailable"; error: string }>;
};

type AttachInput =
  | { source: "slack"; teamId: string; slackUserId: string; appId: string; installationId: string; threadId: string; requestId: string }
  | { source: "runner"; prismUserId: string; slackConnectionId: string; installationId: string; threadId: string; requestId: string };

export function createRemoteCodexBindingService({ store, slack, now = () => new Date() }: { store: BindingStore; slack: SlackCaller; now?: () => Date }) {
  return {
    async attach(input: AttachInput): Promise<
      | { kind: "attached"; permalink: string; existing: boolean }
      | { kind: "pending" }
      | { kind: "not_found" }
      | { kind: "unavailable"; error: string }
    > {
      const session = input.source === "slack"
        ? await store.findSlackOwnedSession(input)
        : await store.findRunnerOwnedSession(input);
      if (!session) return { kind: "not_found" };

      const reservation = await store.reserve(session, now());
      if (reservation.binding.teamId !== session.teamId) {
        if (reservation.created) {
          await store.fail(reservation.binding.id, now()).catch(() => undefined);
        }
        return { kind: "unavailable", error: "binding_workspace_conflict" };
      }
      if (!reservation.created) {
        if (reservation.binding.state === "active" && reservation.binding.channelId && reservation.binding.threadTs) {
          return { kind: "attached", permalink: slackPermalink(reservation.binding.channelId, reservation.binding.threadTs), existing: true };
        }
        return { kind: "pending" };
      }

      const common = {
        ownerKey: session.installationId,
        connectionId: session.connectionId,
        prismUserId: session.prismUserId,
        slackUserId: session.slackUserId,
        slackTeamId: session.teamId,
        activityType: "remote_codex_binding_created" as const,
        surface: input.source === "slack" ? "app_home" as const : "runner" as const,
        objectType: "remote_codex_binding",
        objectId: reservation.binding.id,
        requestId: input.requestId
      };
      try {
        const conversation = await slack.call({ ...common, method: "conversations.open", payload: { users: session.slackUserId } });
        const channelId = conversation.kind === "ok" ? readChannelId(conversation.body) : null;
        if (!channelId) {
          await store.fail(reservation.binding.id, now());
          return { kind: "unavailable", error: conversation.kind === "unavailable" ? conversation.error : "invalid_slack_response" };
        }
        const message = await slack.call({
          ...common,
          method: "chat.postMessage",
          payload: {
            channel: channelId,
            text: `${session.title} is ${statusLabel(session.status)} in Prism Companion`,
            blocks: buildRemoteCodexStatusBlocks(session)
          }
        });
        const threadTs = message.kind === "ok" ? readMessageTs(message.body) : null;
        if (!threadTs) {
          await store.fail(reservation.binding.id, now());
          return { kind: "unavailable", error: message.kind === "unavailable" ? message.error : "invalid_slack_response" };
        }
        const active = await store.activate({ bindingId: reservation.binding.id, channelId, threadTs, now: now() });
        if (!active) {
          await store.fail(reservation.binding.id, now());
          return { kind: "unavailable", error: "binding_activation_failed" };
        }
        return { kind: "attached", permalink: slackPermalink(channelId, threadTs), existing: false };
      } catch {
        await store.fail(reservation.binding.id, now()).catch(() => undefined);
        return { kind: "unavailable", error: "binding_operation_failed" };
      }
    }
  };
}

export function buildRemoteCodexStatusBlocks(session: OwnedRemoteCodexSession): unknown[] {
  const detail = session.status === "unavailable"
    ? "This session is not currently available on the computer. It will update here if it returns."
    : "Status updates are mirrored here.\nSending commands from Slack is not enabled yet.";
  return [
    { type: "header", text: { type: "plain_text", text: session.title.slice(0, 90) } },
    { type: "section", text: { type: "mrkdwn", text: `\`${slackText(session.projectLabel)}\` · ${slackText(session.machineLabel)}\n*${statusLabel(session.status)}* · ${detail}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: "This private thread belongs to your paired Prism identity." }] }
  ];
}

export function statusLabel(status: OwnedRemoteCodexSession["status"]): string {
  if (status === "unavailable") return "Not currently available on computer";
  if (status === "active") return "In progress on computer";
  if (status === "attention") return "Needs attention";
  return "Ready";
}

function readChannelId(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.channel) || typeof body.channel.id !== "string") return null;
  return /^[A-Z][A-Z0-9]{1,20}$/.test(body.channel.id) ? body.channel.id : null;
}

function readMessageTs(body: unknown): string | null {
  if (!isRecord(body) || typeof body.ts !== "string") return null;
  return /^\d{10,16}\.\d{6}$/.test(body.ts) ? body.ts : null;
}

function slackPermalink(channelId: string, timestamp: string): string {
  return `https://slack.com/archives/${channelId}/p${timestamp.replace(".", "")}`;
}

function slackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
