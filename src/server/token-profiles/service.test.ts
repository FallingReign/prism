import { describe, expect, it } from "vitest";

import { createTokenProfile, listTokenProfiles, type TokenProfileStore } from "./service";

const now = new Date("2026-01-01T00:00:00.000Z");

function createMemoryStore(): TokenProfileStore & {
  rows: {
    profiles: unknown[];
    verifiers: unknown[];
  };
} {
  const rows = {
    profiles: [] as any[],
    verifiers: [] as any[]
  };

  return {
    rows,
    async resolveOwner() {
      return { prismUserId: "user_1", slackConnectionId: "conn_1", slackStatus: "healthy" };
    },
    async listProfiles() {
      return rows.profiles.map(({ tokenHash, ...profile }) => profile);
    },
    async insertProfileWithVerifier(input) {
      if (rows.profiles.some((profile) => profile.prismUserId === input.prismUserId && profile.nameNormalized === input.nameNormalized)) {
        return { kind: "duplicate_name" };
      }
      const { verifier, ...profileInput } = input;
      const profile = { id: `profile_${rows.profiles.length + 1}`, ...profileInput, createdAt: now, updatedAt: now };
      rows.profiles.push(profile);
      rows.verifiers.push({ tokenProfileId: profile.id, ...verifier });
      return { kind: "created", profile };
    }
  };
}

describe("Token profile service", () => {
  it("creates multiple named profiles for one Slack-linked user and returns token plaintext only from creation", async () => {
    const store = createMemoryStore();
    const first = await createTokenProfile({
      store,
      sessionToken: "session-token",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      input: {
        name: "Local MCP read",
        intendedUse: "Read Slack context from my local MCP server",
        preset: "read_only",
        executionIdentity: "automatic"
      },
      now,
      randomBytes: () => Buffer.alloc(32, 8)
    });
    const second = await createTokenProfile({
      store,
      sessionToken: "session-token",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      input: {
        name: "Message writer",
        intendedUse: "Post approved messages from a local CLI",
        preset: "messages_only",
        executionIdentity: "user"
      },
      now,
      randomBytes: () => Buffer.alloc(32, 9)
    });

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("created");
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected created profiles");
    expect(first.developerToken).toMatch(/^prism_dev_/);
    expect(first.profile).toMatchObject({ name: "Local MCP read", intendedUse: "Read Slack context from my local MCP server", preset: "read_only" });
    expect(second.profile).toMatchObject({ name: "Message writer", preset: "messages_only" });
    expect(store.rows.verifiers).toHaveLength(2);

    const persisted = JSON.stringify(store.rows);
    expect(persisted).not.toContain(first.developerToken);
    expect(persisted).not.toContain(second.developerToken);
    expect(persisted).not.toContain("pepper-canary");

    const listed = await listTokenProfiles({ store, sessionToken: "session-token" });
    expect(listed.kind).toBe("profiles");
    expect(JSON.stringify(listed)).not.toContain(first.developerToken);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
  });
});
