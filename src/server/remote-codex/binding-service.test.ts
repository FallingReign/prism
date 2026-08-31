import { describe, expect, it, vi } from "vitest";

import { createRemoteCodexBindingService, type BindingStore, type OwnedRemoteCodexSession } from "./binding-service";

const session: OwnedRemoteCodexSession = {
  installationId: "rc_install_1", threadId: "thread_1", title: "Ship companion",
  projectLabel: "remote-codex", machineLabel: "Workstation", status: "active", prismUserId: "owner_1",
  connectionId: "connection-owner", teamId: "T123", slackUserId: "U123"
};

describe("remote Codex Slack binding", () => {
  it("creates one private owner DM root and activates the reservation", async () => {
    const store = fakeStore();
    store.findSlackOwnedSession = vi.fn(async () => session);
    store.reserve = vi.fn(async () => ({ binding: binding("creating"), created: true }));
    store.activate = vi.fn(async ({ channelId, threadTs }) => ({ ...binding("active"), channelId, threadTs }));
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const service = createRemoteCodexBindingService({
      store,
      slack: { call: vi.fn(async (input) => {
        calls.push({ method: input.method, payload: input.payload });
        return input.method === "conversations.open"
          ? { kind: "ok", body: { ok: true, channel: { id: "D123" } } } as const
          : { kind: "ok", body: { ok: true, channel: "D123", ts: "1788148800.000100" } } as const;
      }) },
      now: () => new Date("2026-08-31T08:00:00.000Z")
    });
    await expect(service.attach({ source: "slack", teamId: "T123", slackUserId: "U123", installationId: "rc_install_1", threadId: "thread_1", requestId: "request_1" })).resolves.toEqual({
      kind: "attached", permalink: "https://slack.com/archives/D123/p1788148800000100", existing: false
    });
    expect(calls.map((call) => call.method)).toEqual(["conversations.open", "chat.postMessage"]);
    expect(calls[0]?.payload).toEqual({ users: "U123" });
    expect(JSON.stringify(calls[1]?.payload)).toContain("In progress on computer");
    expect(JSON.stringify(calls)).not.toMatch(/prompt|transcript|output|cwd|secret-canary/i);
  });

  it("returns the existing Slack thread without another Slack API call", async () => {
    const store = fakeStore();
    store.findRunnerOwnedSession = vi.fn(async () => session);
    store.reserve = vi.fn(async () => ({ binding: { ...binding("active"), channelId: "D123", threadTs: "1788148800.000100" }, created: false }));
    const slack = { call: vi.fn() };
    const service = createRemoteCodexBindingService({ store, slack });
    await expect(service.attach({ source: "runner", prismUserId: "owner_1", slackConnectionId: "connection-owner", installationId: "rc_install_1", threadId: "thread_1", requestId: "request_2" })).resolves.toMatchObject({ kind: "attached", existing: true });
    expect(slack.call).not.toHaveBeenCalled();
  });

  it("fails closed instead of reusing an existing binding from another workspace", async () => {
    const store = fakeStore();
    store.findRunnerOwnedSession = vi.fn(async () => session);
    store.reserve = vi.fn(async () => ({
      binding: { ...binding("active"), teamId: "T999", channelId: "D999", threadTs: "1788148800.000100" },
      created: false
    }));
    const slack = { call: vi.fn() };
    const service = createRemoteCodexBindingService({ store, slack });

    await expect(service.attach({ source: "runner", prismUserId: "owner_1", slackConnectionId: "connection-owner", installationId: "rc_install_1", threadId: "thread_1", requestId: "request_workspace_switch" }))
      .resolves.toEqual({ kind: "unavailable", error: "binding_workspace_conflict" });
    expect(store.activate).not.toHaveBeenCalled();
    expect(slack.call).not.toHaveBeenCalled();
  });

  it("does not reserve or call Slack for a cross-owner selection", async () => {
    const store = fakeStore();
    const slack = { call: vi.fn() };
    const service = createRemoteCodexBindingService({ store, slack });
    await expect(service.attach({ source: "slack", teamId: "T999", slackUserId: "U999", installationId: "rc_install_1", threadId: "thread_1", requestId: "request_3" })).resolves.toEqual({ kind: "not_found" });
    expect(store.reserve).not.toHaveBeenCalled();
    expect(slack.call).not.toHaveBeenCalled();
  });

  it("releases a creating reservation when Slack or credential custody throws", async () => {
    const store = fakeStore();
    store.findSlackOwnedSession = vi.fn(async () => session);
    store.reserve = vi.fn(async () => ({ binding: binding("creating"), created: true }));
    const service = createRemoteCodexBindingService({ store, slack: { call: vi.fn(async () => { throw new Error("upstream canary"); }) } });
    await expect(service.attach({ source: "slack", teamId: "T123", slackUserId: "U123", installationId: "rc_install_1", threadId: "thread_1", requestId: "request_4" })).resolves.toEqual({
      kind: "unavailable", error: "binding_operation_failed"
    });
    expect(store.fail).toHaveBeenCalledWith("rc_binding_1", expect.any(Date));
  });
});

function binding(state: "creating" | "active") {
  return { id: "rc_binding_1", installationId: "rc_install_1", threadId: "thread_1", teamId: "T123", channelId: null, threadTs: null, state } as const;
}
function fakeStore(): BindingStore {
  return {
    findSlackOwnedSession: vi.fn(async () => null), findRunnerOwnedSession: vi.fn(async () => null),
    reserve: vi.fn(), activate: vi.fn(), fail: vi.fn(async () => undefined)
  };
}
