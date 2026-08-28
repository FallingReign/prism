import { describe, expect, it, vi } from "vitest";

import { fetchAllGrantedSlackTeams } from "./organization-workspaces";

describe("Slack organization workspace discovery", () => {
  it("fully paginates and deduplicates teams before returning an authoritative result", async () => {
    const callMethod = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { ok: true, teams: [{ id: "T111", name: "One" }], response_metadata: { next_cursor: "page-2" } } })
      .mockResolvedValueOnce({ status: 200, body: { ok: true, teams: [{ id: "T111", name: "One renamed" }, { id: "T222", name: "Two" }], response_metadata: { next_cursor: "" } } });

    await expect(fetchAllGrantedSlackTeams({ callMethod }, "xoxp-test-canary")).resolves.toEqual({
      kind: "ok",
      teams: [{ teamId: "T111", teamName: "One renamed" }, { teamId: "T222", teamName: "Two" }]
    });
    expect(callMethod.mock.calls[1]?.[0].payload).toMatchObject({ cursor: "page-2" });
  });

  it.each([
    ["provider failure", [{ status: 429, body: { ok: false, error: "ratelimited" } }], "ratelimited"],
    ["malformed team", [{ status: 200, body: { ok: true, teams: [{ id: "bad" }], response_metadata: { next_cursor: "" } } }], "slack_directory_unavailable"],
    ["missing cursor metadata", [{ status: 200, body: { ok: true, teams: [{ id: "T111" }] } }], "slack_directory_unavailable"],
    ["cursor loop", [
      { status: 200, body: { ok: true, teams: [], response_metadata: { next_cursor: "again" } } },
      { status: 200, body: { ok: true, teams: [], response_metadata: { next_cursor: "again" } } }
    ], "workspace_pagination_loop"]
  ])("fails closed on %s", async (_label, responses, error) => {
    const callMethod = vi.fn();
    for (const response of responses as Array<{ status: number; body: unknown }>) callMethod.mockResolvedValueOnce(response);
    await expect(fetchAllGrantedSlackTeams({ callMethod }, "xoxp-test-canary")).resolves.toEqual({ kind: "provider_error", error });
  });

  it("bounds OAuth completion when Slack workspace discovery stalls", async () => {
    const callMethod = vi.fn(() => new Promise<never>(() => undefined));
    const startedAt = Date.now();

    await expect(fetchAllGrantedSlackTeams({ callMethod }, "xoxp-test-canary", { timeoutMs: 20 })).resolves.toEqual({
      kind: "provider_error",
      error: "workspace_discovery_timeout"
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(callMethod).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });
});
