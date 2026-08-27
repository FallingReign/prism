import { describe, expect, it } from "vitest";

import { createMockSlackOAuthClient } from "./mock-oauth-client";

describe("mock Slack OAuth client", () => {
  it("returns the configured user scopes and realistic Slack identifiers", async () => {
    const client = createMockSlackOAuthClient({
      botScopes: ["channels:read"],
      userScopes: ["search:read", "chat:write"]
    });

    const result = await client.exchangeCode({ code: "mock-code", redirectUri: "http://localhost/callback" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected mock OAuth success");
    expect(result.appId).toMatch(/^A[A-Z0-9]{8,}$/);
    expect(result.team?.id).toMatch(/^T[A-Z0-9]{8,}$/);
    expect(result.authedUser.id).toMatch(/^U[A-Z0-9]{8,}$/);
    expect(result.authedUser.scope).toBe("search:read,chat:write");
    expect(result.bot?.scope).toBe("channels:read");
  });

  it("does not invent chat:write when the configured user scopes omit it", async () => {
    const result = await createMockSlackOAuthClient({ userScopes: ["search:read"] })
      .exchangeCode({ code: "mock-code", redirectUri: "http://localhost/callback" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected mock OAuth success");
    expect(result.authedUser.scope?.split(",")).not.toContain("chat:write");
  });
});
