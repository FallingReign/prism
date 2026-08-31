import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { publishBoundSessionStatuses } from "./binding-status";

describe("bound Remote Codex status projection", () => {
  it("updates only active owned binding roots with the safe status projection", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("b.state = 'active'");
      expect(sql).not.toMatch(/prompt|transcript|output|cwd|diff/i);
      expect(params).toEqual(["rc_install_1", ""]);
      return { rows: [{
        binding_id: "rc_binding_1", installation_id: "rc_install_1", codex_thread_id: "thread_1",
        safe_title: "Ship companion", project_label: "remote-codex", status: "attention",
        machine_label: "Workstation", prism_user_id: "owner_1", slack_connection_id: "connection-owner",
        team_id: "T123", authed_user_id: "U123", channel_id: "D123", root_message_ts: "1788148800.000100",
        workspace_authorized: true
      }], rowCount: 1 };
    });
    const call = vi.fn(async (input) => {
      expect(input).toMatchObject({
        method: "chat.update", activityType: "remote_codex_binding_status_updated",
        surface: "remote_codex_sync", slackUserId: "U123", slackTeamId: "T123"
      });
      expect(input.payload).toMatchObject({ channel: "D123", ts: "1788148800.000100" });
      expect(JSON.stringify(input.payload)).toContain("Needs attention");
      expect(JSON.stringify(input.payload)).not.toMatch(/prompt|transcript|output|cwd|secret-canary/i);
      return { kind: "ok", body: { ok: true } } as const;
    });
    await expect(publishBoundSessionStatuses({
      database: fakeDatabase(query), slack: { call }, installationId: "rc_install_1", requestId: "request_1"
    })).resolves.toEqual({ found: 1, updated: 1 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 20, 21, 50, 51])("reconciles all %i bindings through bounded pages", async (count) => {
    const rows = Array.from({ length: count }, (_, index) => boundRow(index + 1));
    const query = vi.fn(async (_sql: string, params?: unknown[]) => {
      const cursor = String(params?.[1] ?? "");
      const start = cursor ? rows.findIndex((row) => row.binding_id === cursor) + 1 : 0;
      const page = rows.slice(start, start + 20);
      return { rows: page, rowCount: page.length };
    });
    const call = vi.fn(async () => ({ kind: "ok", body: { ok: true } }) as const);

    await expect(publishBoundSessionStatuses({
      database: fakeDatabase(query), slack: { call }, installationId: "rc_install_1", requestId: "request_pages"
    })).resolves.toEqual({ found: count, updated: count });
    expect(call).toHaveBeenCalledTimes(count);
    expect(query).toHaveBeenCalledTimes(Math.floor(count / 20) + 1);
  });

  it("publishes unavailable status, retries failed updates, and skips revoked workspace grants", async () => {
    const query = vi.fn(async () => ({
      rows: [
        boundRow(1, { status: "unavailable" }),
        boundRow(2, { workspace_authorized: false, team_id: "TREVOKED" })
      ],
      rowCount: 2
    }));
    const call = vi.fn()
      .mockResolvedValueOnce({ kind: "unavailable", error: "slack_temporarily_unavailable" })
      .mockResolvedValueOnce({ kind: "ok", body: { ok: true } });

    await expect(publishBoundSessionStatuses({
      database: fakeDatabase(query), slack: { call }, installationId: "rc_install_1", requestId: "request_retry_1"
    })).resolves.toEqual({ found: 2, updated: 0 });
    await expect(publishBoundSessionStatuses({
      database: fakeDatabase(query), slack: { call }, installationId: "rc_install_1", requestId: "request_retry_2"
    })).resolves.toEqual({ found: 2, updated: 1 });

    expect(call).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(call.mock.calls[0]?.[0]?.payload)).toContain("Not currently available on computer");
    expect(call.mock.calls.some(([input]) => input.slackTeamId === "TREVOKED")).toBe(false);
  });
});

function boundRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    binding_id: `rc_binding_${String(index).padStart(3, "0")}`,
    installation_id: "rc_install_1",
    codex_thread_id: `thread_${index}`,
    safe_title: `Session ${index}`,
    project_label: "remote-codex",
    status: "ready",
    machine_label: "Workstation",
    prism_user_id: "owner_1",
    slack_connection_id: "connection-owner",
    team_id: "T123",
    authed_user_id: "U123",
    channel_id: "D123",
    root_message_ts: `1788148800.${String(index).padStart(6, "0")}`,
    workspace_authorized: true,
    ...overrides
  };
}

function fakeDatabase(query: ReturnType<typeof vi.fn>): Database {
  const value: Database = { query: query as unknown as Database["query"], transaction: async (callback) => callback(value) };
  return value;
}
