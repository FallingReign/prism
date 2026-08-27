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
      prismUserId: "user_1", slackConnectionId: "conn_org", store,
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
      prismUserId: "user_1", slackConnectionId: "conn_org", store,
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
      prismUserId: "cache_user_1", slackConnectionId: "conn_workspace", teamId: "T111", cursor: "", limit: 100,
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
      prismUserId: "user_1", slackConnectionId: "conn_workspace", teamId: "T999", cursor: "", limit: 100,
      store: fakeStore(), credentialProvider: availableCredential(), slackClient: { callMethod }, now
    })).resolves.toEqual({ kind: "not_found", error: "workspace_not_granted" });
    expect(callMethod).not.toHaveBeenCalled();
  });

  it("scopes workspace directory reads to the connection embedded in the Playtest credential", async () => {
    const listConnections = vi.fn(async (input: { prismUserId: string; slackConnectionId: string }) => {
      if (input.slackConnectionId !== "conn_token") throw new Error("cross-connection lookup");
      return [{
        connectionId: "conn_token", installationScope: "workspace" as const, teamId: "T111", teamName: "Token workspace",
        enterpriseId: null, enterpriseName: null, grantsVerifiedAt: now
      }];
    });
    const listWorkspaces = vi.fn(async (input: { prismUserId: string; slackConnectionId: string }) => {
      return input.slackConnectionId === "conn_token"
        ? [{ teamId: "T111", teamName: "Token workspace", installationScope: "workspace" as const, enterpriseName: null, lastVerifiedAt: now }]
        : [{ teamId: "T999", teamName: "Other connection", installationScope: "workspace" as const, enterpriseName: null, lastVerifiedAt: now }];
    });

    const result = await listPlaytestWorkspaces({
      prismUserId: "user_1", slackConnectionId: "conn_token", store: fakeStore({ listConnections, listWorkspaces }),
      credentialProvider: availableCredential(), slackClient: { callMethod: vi.fn() }, now
    });

    expect(result).toMatchObject({ kind: "ok", value: [{ teamId: "T111" }] });
    expect(listConnections).toHaveBeenCalledWith({ prismUserId: "user_1", slackConnectionId: "conn_token" });
    expect(listWorkspaces).toHaveBeenCalledWith({ prismUserId: "user_1", slackConnectionId: "conn_token" });
  });

  it("revalidates the target before serving a cached channel page", async () => {
    const resolveConnection = vi.fn()
      .mockResolvedValueOnce({ connectionId: "conn_workspace" })
      .mockResolvedValueOnce(null);
    const callMethod = vi.fn().mockResolvedValue({
      status: 200,
      body: { ok: true, channels: [{ id: "C111", name: "playtests", is_private: false }], response_metadata: { next_cursor: "" } }
    });
    const input = {
      prismUserId: "revoked_cache_user", slackConnectionId: "conn_workspace", teamId: "T111", cursor: "", limit: 100,
      store: fakeStore({ resolveConnection }), credentialProvider: availableCredential(), slackClient: { callMethod }, now
    };

    expect(await listPlaytestChannels(input)).toMatchObject({ kind: "ok", cache: "miss" });
    await expect(listPlaytestChannels(input)).resolves.toEqual({ kind: "not_found", error: "workspace_not_granted" });
    expect(resolveConnection).toHaveBeenCalledTimes(2);
    expect(resolveConnection).toHaveBeenCalledWith({
      prismUserId: "revoked_cache_user", slackConnectionId: "conn_workspace", teamId: "T111"
    });
    expect(callMethod).toHaveBeenCalledTimes(1);
  });

  it("does not replace grants when an auth.teams.list page contains malformed entries", async () => {
    const replaceOrganizationGrants = vi.fn(async () => undefined);
    const store = fakeStore({
      listConnections: async () => [{
        connectionId: "conn_org", installationScope: "organization", teamId: null, teamName: null,
        enterpriseId: "E123", enterpriseName: "Example Org", grantsVerifiedAt: null
      }],
      replaceOrganizationGrants
    });
    const callMethod = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        ok: true,
        teams: [{ id: "T111", name: "One" }, { id: "not-a-team", name: "Malformed" }],
        response_metadata: { next_cursor: "" }
      }
    });

    await expect(listPlaytestWorkspaces({
      prismUserId: "user_1", slackConnectionId: "conn_org", store,
      credentialProvider: availableCredential(), slackClient: { callMethod }, now
    })).resolves.toEqual({ kind: "provider_error", error: "slack_directory_unavailable" });
    expect(replaceOrganizationGrants).not.toHaveBeenCalled();
  });

  it("does not replace grants when an auth.teams.list page omits cursor metadata", async () => {
    const replaceOrganizationGrants = vi.fn(async () => undefined);
    const store = fakeStore({
      listConnections: async () => [{
        connectionId: "conn_org", installationScope: "organization", teamId: null, teamName: null,
        enterpriseId: "E123", enterpriseName: "Example Org", grantsVerifiedAt: null
      }],
      replaceOrganizationGrants
    });

    await expect(listPlaytestWorkspaces({
      prismUserId: "user_1", slackConnectionId: "conn_org", store,
      credentialProvider: availableCredential(),
      slackClient: { callMethod: vi.fn().mockResolvedValue({ status: 200, body: { ok: true, teams: [{ id: "T111", name: "One" }] } }) },
      now
    })).resolves.toEqual({ kind: "provider_error", error: "slack_directory_unavailable" });
    expect(replaceOrganizationGrants).not.toHaveBeenCalled();
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
