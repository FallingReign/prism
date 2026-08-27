import { describe, expect, it, vi } from "vitest";

import {
  PLAYTEST_APP_CAPABILITY_MAP,
  PLAYTEST_APP_CLIENT_ID,
  PLAYTEST_APP_PROFILE_NAME,
  PLAYTEST_APP_TOKEN_TTL_SECONDS,
  issuePlaytestAppCredential
} from "./first-party-app";

describe("Playtest first-party app credential", () => {
  it("mints an eight-hour copy-once token with a fixed user-only message policy", async () => {
    const issuePlaytestAppToken = vi.fn(async () => ({ profileId: "profile_playtest" }));
    const now = new Date("2026-08-26T00:00:00.000Z");
    const result = await issuePlaytestAppCredential({
      store: { issuePlaytestAppToken },
      developerTokenConfig: { pepper: "playtest-pepper-secret", pepperId: "v1" },
      prismUserId: "user-1",
      slackConnectionId: "connection-1",
      requestId: "request-1",
      now,
      randomBytes: () => Buffer.alloc(32, 7)
    });

    expect(result).toEqual({
      token: expect.stringMatching(/^prism_dev_[A-Za-z0-9_-]{43}$/),
      expiresIn: PLAYTEST_APP_TOKEN_TTL_SECONDS,
      profileId: "profile_playtest"
    });
    expect(issuePlaytestAppToken).toHaveBeenCalledWith(expect.objectContaining({
      prismUserId: "user-1",
      slackConnectionId: "connection-1",
      expiresAt: new Date("2026-08-26T08:00:00.000Z"),
      verifier: expect.objectContaining({ tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    }));
    expect(JSON.stringify(issuePlaytestAppToken.mock.calls)).not.toContain(result?.token);
    expect(PLAYTEST_APP_CLIENT_ID).toBe("shg-playtest");
    expect(PLAYTEST_APP_PROFILE_NAME).toBe("shg_playtest_app");
    expect(PLAYTEST_APP_CAPABILITY_MAP).toMatchObject({
      actions: { read: false, search: false, writeMessages: true, reactions: false, destructive: false },
      executionIdentity: "user"
    });
  });

  it("returns no raw credential when the owned user Slack connection is unavailable", async () => {
    await expect(issuePlaytestAppCredential({
      store: { issuePlaytestAppToken: vi.fn(async () => null) },
      developerTokenConfig: { pepper: "playtest-pepper-secret", pepperId: "v1" },
      prismUserId: "user-1",
      slackConnectionId: "connection-1",
      requestId: "request-1"
    })).resolves.toBeNull();
  });
});
