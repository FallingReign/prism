import { describe, expect, it, vi } from "vitest";

import { listPlaytestChannels, listPlaytestWorkspaces, type PlaytestDirectoryStore } from "./directory";

const now = new Date("2026-08-27T00:00:00.000Z");

describe("Playtest Slack directory", () => {
  it("fully paginates organization grants before atomically replacing them", async () => {
    const replaceOrganizationGrants = vi.fn(async () => undefined);
    const store = fakeStore({
      listConnections: async () => [{
        connectionId: "conn_org", installationScope: "organization", teamId: null, teamName: null,
        enterpriseId: "E123", enterpriseName: "Example Org", grantsVerifiedAt: null
      }],
      replaceOrganizationGrants,
      listWorkspaces: async () => []
    });
    const callMethod = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { ok: true, teams: [{ id: "T111", name: "One" }], response_metadata: { next_cursor: "page-2" } } })
      .mockResolvedValueOnce({ status: 200, body: { ok: true, teams: [{ id: "T222", name: "Two" }], response_metadata: { next_cursor: "" } } });

    const result = await listPlaytestWorkspaces({
      prismUserId: "user_1", store,
      credentialProvider: availableCredential(), slackClient: { callMethod }, now
    });

    expect(result.kind).toBe("ok");
    expect(replaceOrganizationGrants).toHaveBeenCalledWith({
      connectionId: "conn_org",
      teams: [{ teamId: "T111", teamName: "One" }, { teamId: "T222", teamName: "Two" }],
      verifiedAt: now
    });
    expect(callMethod.mock.calls[1]?.[0].payload).toMatchObject({ cursor: "page-2" });
  });

  it("never replaces grants after a partial provider failure", async () => {
    const replaceOrganizationGrants = vi.fn(async () => undefined);
    const store = fakeStore({
      listConnections: async () => [{
        connectionId: "conn_org", installationScope: "organization", teamId: null, teamName: null,
        enterpriseId: "E123", enterpriseName: "Example Org", grantsVerifiedAt: null
      }],
      replaceOrganizationGrants
    });
    const callMethod = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { ok: true, teams: [{ id: "T111", name: "One" }], response_metadata: { next_cursor: "page-2" } } })
      .mockResolvedValueOnce({ status: 429, body: { ok: false, error: "ratelimited" } });

    await expect(listPlaytestWorkspaces({
      prismUserId: "user_1", store,
      credentialProvider: availableCredential(), slackClient: { callMethod }, now
    })).resolves.toEqual({ kind: "provider_error", error: "ratelimited" });
    expect(replaceOrganizationGrants).not.toHaveBeenCalled();
  });

  it("lists member-visible channels with an explicit workspace and caches identical picker reads", async () => {
    const callMethod = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        ok: true,
        channels: [
          { id: "C111", name: "playtests", is_private: false },
          { id: "G222", name: "private-playtests", is_private: true },
          { id: "C333", name: "archive", is_archived: true }
        ],
        response_metadata: { next_cursor: "next" }
      }
    });
    const input = {
      prismUserId: "cache_user_1", teamId: "T111", cursor: "", limit: 100,
      store: fakeStore({ resolveConnection: async () => ({ connectionId: "conn_workspace" }) }),
      credentialProvider: availableCredential(), slackClient: { callMethod }, now
    };

    const first = await listPlaytestChannels(input);
    const second = await listPlaytestChannels(input);

    expect(first).toMatchObject({ kind: "ok", cache: "miss", value: { nextCursor: "next" } });
    expect(second).toMatchObject({ kind: "ok", cache: "hit" });
    expect(callMethod).toHaveBeenCalledTimes(1);
    expect(callMethod.mock.calls[0]?.[0].payload).toMatchObject({
      team_id: "T111", types: "public_channel,private_channel", exclude_archived: true
    });
    if (first.kind === "ok") expect(first.value.channels).toHaveLength(2);
  });

  it("does not enumerate channels for an ungranted workspace", async () => {
    const callMethod = vi.fn();
    await expect(listPlaytestChannels({
      prismUserId: "user_1", teamId: "T999", cursor: "", limit: 100,
      store: fakeStore(), credentialProvider: availableCredential(), slackClient: { callMethod }, now
    })).resolves.toEqual({ kind: "not_found", error: "workspace_not_granted" });
    expect(callMethod).not.toHaveBeenCalled();
  });
});

function fakeStore(overrides: Partial<PlaytestDirectoryStore> = {}): PlaytestDirectoryStore {
  return {
    listConnections: async () => [],
    replaceOrganizationGrants: async () => undefined,
    listWorkspaces: async () => [],
    resolveConnection: async () => null,
    ...overrides
  };
}

function availableCredential() {
  return { getAccessToken: vi.fn(async () => ({ kind: "available" as const, accessToken: "xoxp-test-canary" })) };
}
