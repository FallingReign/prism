import { describe, expect, it } from "vitest";

import { buildCurrentGlobalTokenProfilePolicy, type GlobalTokenProfilePolicy } from "./global-policy";
import { createTokenProfile, deleteTokenProfile, listTokenProfiles, revokeTokenProfile, rotateTokenProfile, updateTokenProfilePolicy, type TokenProfileStore } from "./service";

const now = new Date("2026-01-01T00:00:00.000Z");

function createMemoryStore(): TokenProfileStore & {
  rows: {
    profiles: any[];
    verifiers: any[];
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
      return rows.profiles.map((profile) => {
        const verifier = rows.verifiers.find((candidate) => candidate.tokenProfileId === profile.id && candidate.isCurrent !== false);
        return {
          ...profile,
          developerToken: verifier
            ? {
                status: verifier.revokedAt ? "revoked" : verifier.expiresAt && verifier.expiresAt <= now ? "expired" : "active",
                createdAt: verifier.createdAt ?? now,
                expiresAt: verifier.expiresAt ?? null,
                lastUsedAt: verifier.lastUsedAt ?? null,
                revokedAt: verifier.revokedAt ?? null,
                overlapExpiresAt: verifier.overlapExpiresAt ?? null
              }
            : { status: "missing" }
        };
      });
    },
    async insertProfileWithVerifier(input) {
      if (rows.profiles.some((profile) => profile.prismUserId === input.prismUserId && profile.nameNormalized === input.nameNormalized)) {
        return { kind: "duplicate_name" };
      }
      const { verifier, ...profileInput } = input;
      const profile = { id: `profile_${rows.profiles.length + 1}`, ...profileInput, policyEffectiveAt: now, createdAt: now, updatedAt: now };
      rows.profiles.push(profile);
      rows.verifiers.push({ tokenProfileId: profile.id, ...verifier, expiresAt: input.expiresAt, isCurrent: true, createdAt: now });
      return { kind: "created", profile };
    },
    async revokeProfileDeveloperTokens(input) {
      const profile = rows.profiles.find(
        (candidate) => candidate.id === input.profileId && candidate.prismUserId === input.prismUserId && candidate.slackConnectionId === input.slackConnectionId
      );
      if (!profile) return { kind: "not_found" };
      for (const verifier of rows.verifiers.filter((candidate) => candidate.tokenProfileId === profile.id && !candidate.revokedAt)) {
        verifier.revokedAt = input.now;
        verifier.isCurrent = false;
      }
      profile.status = "revoked";
      return { kind: "revoked", profile: { ...profile, status: "revoked", developerToken: { status: "revoked", revokedAt: input.now, lastUsedAt: null, expiresAt: null } } };
    },
    async deleteInactiveProfile(input) {
      const profileIndex = rows.profiles.findIndex(
        (candidate) => candidate.id === input.profileId && candidate.prismUserId === input.prismUserId && candidate.slackConnectionId === input.slackConnectionId
      );
      if (profileIndex === -1) return { kind: "not_found" };
      const profile = rows.profiles[profileIndex]!;
      const hasActiveVerifier = rows.verifiers.some(
        (candidate) => candidate.tokenProfileId === profile.id && candidate.isCurrent !== false && !candidate.revokedAt && (!candidate.expiresAt || candidate.expiresAt > input.now)
      );
      if (profile.status === "active" && hasActiveVerifier) return { kind: "conflict" };
      rows.profiles.splice(profileIndex, 1);
      rows.verifiers = rows.verifiers.filter((candidate) => candidate.tokenProfileId !== profile.id);
      return { kind: "deleted", profile };
    },
    async rotateProfileDeveloperToken(input) {
      const profile = rows.profiles.find(
        (candidate) => candidate.id === input.profileId && candidate.prismUserId === input.prismUserId && candidate.slackConnectionId === input.slackConnectionId
      );
      if (!profile) return { kind: "not_found" };
      for (const verifier of rows.verifiers.filter((candidate) => candidate.tokenProfileId === profile.id && !candidate.revokedAt)) {
        verifier.revokedAt = input.overlapExpiresAt ? null : input.now;
        verifier.expiresAt = input.overlapExpiresAt ?? verifier.expiresAt;
        verifier.isCurrent = false;
        verifier.supersededAt = input.now;
      }
      rows.verifiers.push({ tokenProfileId: profile.id, ...input.verifier, expiresAt: profile.expiresAt, isCurrent: true, createdAt: input.now });
      return {
        kind: "rotated",
        profile: {
          ...profile,
          developerToken: { status: "active", createdAt: input.now, expiresAt: profile.expiresAt, lastUsedAt: null, revokedAt: null, overlapExpiresAt: input.overlapExpiresAt }
        }
      };
    },
    async updateProfilePolicy(input) {
      const profile = rows.profiles.find(
        (candidate) => candidate.id === input.profileId && candidate.prismUserId === input.prismUserId && candidate.slackConnectionId === input.slackConnectionId
      );
      if (!profile) return { kind: "not_found" };
      profile.preset = input.preset;
      profile.capabilityMap = input.capabilityMap;
      profile.expiresAt = input.expiresAt;
      profile.policyEffectiveAt = input.policyEffectiveAt;
      profile.updatedAt = input.now;
      if (input.rotation) {
        for (const verifier of rows.verifiers.filter((candidate) => candidate.tokenProfileId === profile.id && !candidate.revokedAt)) {
          verifier.revokedAt = input.now;
          verifier.isCurrent = false;
          verifier.supersededAt = input.now;
        }
        rows.verifiers.push({ tokenProfileId: profile.id, ...input.rotation.verifier, expiresAt: input.expiresAt, isCurrent: true, createdAt: input.now });
      }
      return { kind: "updated", profile };
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

  it("revokes a Token profile developer token without exposing token material", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
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
    if (created.kind !== "created") throw new Error("expected created profile");

    const revoked = await revokeTokenProfile({
      store,
      sessionToken: "session-token",
      profileId: created.profile.id,
      audit: { endpoint: "/v1/prism/token-profiles/profile_1/revoke", requestId: "req_revoke" },
      now
    });

    expect(revoked).toMatchObject({
      kind: "revoked",
      profile: { id: created.profile.id, developerToken: { status: "revoked", revokedAt: now } }
    });
    expect(store.rows.verifiers).toEqual([
      expect.objectContaining({ tokenProfileId: created.profile.id, revokedAt: now, isCurrent: false })
    ]);
    expect(JSON.stringify({ revoked, rows: store.rows })).not.toContain(created.developerToken);
    expect(JSON.stringify({ revoked, rows: store.rows })).not.toContain("pepper-canary");
  });

  it("preserves revoked profiles for listing and deletes only inactive profiles", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
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
    if (created.kind !== "created") throw new Error("expected created profile");

    const blocked = await deleteTokenProfile({ store, sessionToken: "session-token", profileId: created.profile.id, now });
    expect(blocked).toEqual({ kind: "conflict" });

    const revoked = await revokeTokenProfile({ store, sessionToken: "session-token", profileId: created.profile.id, now });
    expect(revoked).toMatchObject({ kind: "revoked", profile: { status: "revoked" } });

    const listed = await listTokenProfiles({ store, sessionToken: "session-token" });
    expect(listed).toMatchObject({ kind: "profiles", profiles: [expect.objectContaining({ id: created.profile.id, status: "revoked" })] });

    const deleted = await deleteTokenProfile({
      store,
      sessionToken: "session-token",
      profileId: created.profile.id,
      audit: { endpoint: "/v1/prism/token-profiles/profile_1", requestId: "req_delete" },
      now
    });
    expect(deleted).toMatchObject({ kind: "deleted", profile: { id: created.profile.id, status: "revoked" } });
    expect(store.rows.profiles).toHaveLength(0);
    expect(store.rows.verifiers).toHaveLength(0);
    expect(JSON.stringify({ deleted, rows: store.rows })).not.toContain(created.developerToken);
    expect(JSON.stringify({ deleted, rows: store.rows })).not.toContain("pepper-canary");
  });

  it("rotates a Token profile developer token with immediate old-token invalidation and copy-once replacement", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
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
    if (created.kind !== "created") throw new Error("expected created profile");

    const rotated = await rotateTokenProfile({
      store,
      sessionToken: "session-token",
      profileId: created.profile.id,
      overlap: "none",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      audit: { endpoint: "/v1/prism/token-profiles/profile_1/rotate", requestId: "req_rotate" },
      now,
      randomBytes: () => Buffer.alloc(32, 9)
    });

    expect(rotated.kind).toBe("rotated");
    if (rotated.kind !== "rotated") throw new Error("expected rotated profile");
    expect(rotated.developerToken).toMatch(/^prism_dev_/);
    expect(rotated.developerToken).not.toBe(created.developerToken);
    expect(rotated.profile.developerToken).toMatchObject({ status: "active", createdAt: now });
    expect(store.rows.verifiers).toEqual([
      expect.objectContaining({ tokenProfileId: created.profile.id, revokedAt: now, isCurrent: false, supersededAt: now }),
      expect.objectContaining({ tokenProfileId: created.profile.id, isCurrent: true, createdAt: now })
    ]);
    expect(JSON.stringify(store.rows)).not.toContain(created.developerToken);
    expect(JSON.stringify(store.rows)).not.toContain(rotated.developerToken);
    expect(JSON.stringify(store.rows)).not.toContain("pepper-canary");
  });

  it("rotates a Token profile developer token with a bounded overlap window", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
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
      randomBytes: () => Buffer.alloc(32, 8)
    });
    if (created.kind !== "created") throw new Error("expected created profile");

    const rotated = await rotateTokenProfile({
      store,
      sessionToken: "session-token",
      profileId: created.profile.id,
      overlap: "15m",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      now,
      randomBytes: () => Buffer.alloc(32, 9)
    });

    expect(rotated.kind).toBe("rotated");
    if (rotated.kind !== "rotated") throw new Error("expected rotated profile");
    const overlapExpiresAt = new Date("2026-01-01T00:15:00.000Z");
    expect(rotated.profile.developerToken).toMatchObject({ status: "active", overlapExpiresAt });
    expect(store.rows.verifiers[0]).toMatchObject({
      tokenProfileId: created.profile.id,
      revokedAt: null,
      isCurrent: false,
      supersededAt: now,
      expiresAt: overlapExpiresAt
    });
    expect(store.rows.verifiers[1]).toMatchObject({ tokenProfileId: created.profile.id, isCurrent: true, createdAt: now });
    expect(JSON.stringify(store.rows)).not.toContain(rotated.developerToken);
  });

  it("applies narrowing immediately but requires rotation before broadening a Token profile", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
      store,
      sessionToken: "session-token",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      input: {
        name: "Full bridge",
        intendedUse: "Bridge Slack calls from a local CLI",
        preset: "full_slack_bridge",
        executionIdentity: "automatic"
      },
      now,
      randomBytes: () => Buffer.alloc(32, 8)
    });
    if (created.kind !== "created") throw new Error("expected created profile");

    const narrowed = await updateTokenProfilePolicy({
      store,
      sessionToken: "session-token",
      profileId: created.profile.id,
      input: { preset: "read_only", executionIdentity: "automatic", experiment: "24h", name: "Full bridge", intendedUse: "Bridge Slack calls from a local CLI" },
      now
    });
    expect(narrowed).toMatchObject({ kind: "updated", change: "narrowing", profile: { capabilityMap: { preset: "read_only" } } });

    const broadeningBlocked = await updateTokenProfilePolicy({
      store,
      sessionToken: "session-token",
      profileId: created.profile.id,
      input: { preset: "messages_only", executionIdentity: "automatic", name: "Full bridge", intendedUse: "Bridge Slack calls from a local CLI" },
      now
    });
    const broadened = await updateTokenProfilePolicy({
      store,
      sessionToken: "session-token",
      profileId: created.profile.id,
      input: { preset: "messages_only", executionIdentity: "automatic", name: "Full bridge", intendedUse: "Bridge Slack calls from a local CLI" },
      confirmBroadening: true,
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      now,
      randomBytes: () => Buffer.alloc(32, 9)
    });

    expect(broadeningBlocked).toMatchObject({ kind: "rotation_required" });
    expect(broadened.kind).toBe("updated");
    if (broadened.kind !== "updated") throw new Error("expected updated profile");
    expect(broadened.change).toBe("broadening");
    expect(broadened.developerToken).toMatch(/^prism_dev_/);
    expect(store.rows.verifiers).toHaveLength(2);
    expect(store.rows.verifiers[0]).toMatchObject({ revokedAt: now, isCurrent: false });
    expect(store.rows.verifiers[1]).toMatchObject({ isCurrent: true });
    expect(JSON.stringify(store.rows)).not.toContain(broadened.developerToken);
    expect(JSON.stringify(store.rows)).not.toContain("pepper-canary");
  });

  it("rejects Token profile creation that exceeds the Global Token profile policy", async () => {
    const store = createMemoryStore();
    const result = await createTokenProfile({
      store,
      globalPolicyStore: policyReader(
        buildCurrentGlobalTokenProfilePolicy({
          presets: { allowed: ["read_only"], default: "read_only" },
          capabilities: {
            maximum: {
              actions: { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false },
              surfaces: {
                publicChannels: true,
                privateChannels: true,
                directMessages: true,
                groupDirectMessages: true,
                search: true,
                filesMetadata: false,
                canvases: false,
                lists: false,
                future: false
              }
            }
          }
        })
      ),
      sessionToken: "session-token",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      input: {
        name: "Message writer",
        intendedUse: "Post approved messages from a local CLI",
        preset: "messages_only",
        executionIdentity: "automatic"
      },
      now,
      randomBytes: () => Buffer.alloc(32, 8)
    });

    expect(result).toMatchObject({
      kind: "global_policy_violation",
      message: "Requested Token profile policy exceeds the Global Token profile policy.",
      reasons: [
        { code: "preset_disallowed" },
        { code: "action_write_messages_exceeds_maximum" },
        { code: "action_reactions_exceeds_maximum" }
      ]
    });
    expect(store.rows.profiles).toHaveLength(0);
    expect(store.rows.verifiers).toHaveLength(0);
    expect(JSON.stringify(result)).not.toMatch(/prism_dev_|tokenHash|pepper-canary/i);
  });

  it("flags existing profiles Outside global policy without revoking current token metadata", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
      store,
      sessionToken: "session-token",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      input: {
        name: "Message writer",
        intendedUse: "Post approved messages from a local CLI",
        preset: "messages_only",
        executionIdentity: "automatic"
      },
      now,
      randomBytes: () => Buffer.alloc(32, 8)
    });
    if (created.kind !== "created") throw new Error("expected created profile");

    const listed = await listTokenProfiles({
      store,
      globalPolicyStore: policyReader(buildCurrentGlobalTokenProfilePolicy({ presets: { allowed: ["read_only"], default: "read_only" } })),
      sessionToken: "session-token",
      now
    });

    expect(listed).toMatchObject({
      kind: "profiles",
      profiles: [
        {
          id: created.profile.id,
          developerToken: { status: "active" },
          globalPolicyStatus: { kind: "outside", reasons: [{ code: "preset_disallowed" }] }
        }
      ]
    });
    expect(store.rows.verifiers).toEqual([expect.objectContaining({ tokenProfileId: created.profile.id, isCurrent: true })]);
  });

  it("blocks rotation for Outside global policy profiles until they are narrowed", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
      store,
      sessionToken: "session-token",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      input: {
        name: "Message writer",
        intendedUse: "Post approved messages from a local CLI",
        preset: "messages_only",
        executionIdentity: "automatic"
      },
      now,
      randomBytes: () => Buffer.alloc(32, 8)
    });
    if (created.kind !== "created") throw new Error("expected created profile");
    const tightenedPolicy = policyReader(
      buildCurrentGlobalTokenProfilePolicy({
        presets: { allowed: ["read_only", "custom"], default: "read_only" },
        capabilities: {
          defaults: {
            actions: { read: true, search: false, writeMessages: false, reactions: false, filesMetadata: false, destructive: false },
            surfaces: {
              publicChannels: true,
              privateChannels: true,
              directMessages: true,
              groupDirectMessages: true,
              search: false,
              filesMetadata: false,
              canvases: false,
              lists: false,
              future: false
            }
          },
          maximum: {
            actions: { read: true, search: false, writeMessages: false, reactions: false, filesMetadata: false, destructive: false },
            surfaces: {
              publicChannels: true,
              privateChannels: true,
              directMessages: true,
              groupDirectMessages: true,
              search: false,
              filesMetadata: false,
              canvases: false,
              lists: false,
              future: false
            }
          }
        }
      })
    );

    const blocked = await rotateTokenProfile({
      store,
      globalPolicyStore: tightenedPolicy,
      sessionToken: "session-token",
      profileId: created.profile.id,
      overlap: "none",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      now,
      randomBytes: () => Buffer.alloc(32, 9)
    });
    const narrowed = await updateTokenProfilePolicy({
      store,
      globalPolicyStore: tightenedPolicy,
      sessionToken: "session-token",
      profileId: created.profile.id,
      input: {
        name: "Message writer",
        intendedUse: "Post approved messages from a local CLI",
        preset: "custom",
        executionIdentity: "automatic",
        custom: { read: true, search: false, writeMessages: false, reactions: false, filesMetadata: false, destructive: false }
      },
      now
    });

    expect(blocked).toMatchObject({
      kind: "outside_global_policy",
      message: "Narrow this Token profile inside the Global Token profile policy before rotating or broadening it."
    });
    expect(narrowed).toMatchObject({ kind: "updated", change: "narrowing", profile: { globalPolicyStatus: { kind: "inside" } } });
    expect(store.rows.verifiers).toHaveLength(1);
  });

  it("does not let unrelated profile updates reset expiry compliance", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
      store,
      sessionToken: "session-token",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      input: {
        name: "Message writer",
        intendedUse: "Post approved messages from a local CLI",
        preset: "messages_only",
        executionIdentity: "automatic"
      },
      now,
      randomBytes: () => Buffer.alloc(32, 8)
    });
    if (created.kind !== "created") throw new Error("expected created profile");
    store.rows.profiles[0]!.updatedAt = new Date("2026-03-20T00:00:00.000Z");

    const listed = await listTokenProfiles({
      store,
      globalPolicyStore: policyReader(buildCurrentGlobalTokenProfilePolicy({ expiry: { maximumDays: { readOnly: null, nonDestructive: 30, destructive: 30 } } })),
      sessionToken: "session-token",
      now: new Date("2026-03-20T00:00:00.000Z")
    });

    expect(listed).toMatchObject({
      kind: "profiles",
      profiles: [
        {
          id: created.profile.id,
          globalPolicyStatus: { kind: "outside", reasons: [{ code: "expiry_exceeds_maximum" }] }
        }
      ]
    });
  });

  it("does not treat a same-policy template edit as expiry broadening", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
      store,
      sessionToken: "session-token",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      input: {
        name: "Custom reader",
        intendedUse: "Read approved Slack context from a local CLI",
        preset: "custom",
        executionIdentity: "automatic",
        custom: { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false }
      },
      now,
      randomBytes: () => Buffer.alloc(32, 8)
    });
    if (created.kind !== "created") throw new Error("expected created profile");
    const originalExpiry = created.profile.expiresAt;

    const updated = await updateTokenProfilePolicy({
      store,
      sessionToken: "session-token",
      profileId: created.profile.id,
      input: {
        name: "Custom reader",
        intendedUse: "Read approved Slack context from a local CLI",
        preset: "custom",
        executionIdentity: "automatic",
        custom: { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false }
      },
      now: new Date("2026-01-01T01:00:00.000Z")
    });

    expect(updated).toMatchObject({ kind: "updated", change: "unchanged" });
    expect(store.rows.profiles[0]!.expiresAt).toEqual(originalExpiry);
    expect(store.rows.profiles[0]!.policyEffectiveAt).toEqual(now);
    expect(store.rows.verifiers).toHaveLength(1);
  });

  it("allows Outside global policy profiles to apply narrowing without resetting unchanged expiry compliance", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
      store,
      sessionToken: "session-token",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      input: {
        name: "Read-only context",
        intendedUse: "Read approved Slack context from a local CLI",
        preset: "read_only",
        executionIdentity: "selectable"
      },
      now,
      randomBytes: () => Buffer.alloc(32, 8)
    });
    if (created.kind !== "created") throw new Error("expected created profile");
    const updateNow = new Date("2026-02-01T00:00:00.000Z");

    const narrowed = await updateTokenProfilePolicy({
      store,
      globalPolicyStore: policyReader(buildCurrentGlobalTokenProfilePolicy({ expiry: { allowNoExpiryForReadOnly: false } })),
      sessionToken: "session-token",
      profileId: created.profile.id,
      input: {
        name: "Read-only context",
        intendedUse: "Read approved Slack context from a local CLI",
        preset: "read_only",
        executionIdentity: "automatic"
      },
      now: updateNow
    });

    expect(narrowed).toMatchObject({
      kind: "updated",
      change: "narrowing",
      profile: {
        globalPolicyStatus: { kind: "outside", reasons: [{ code: "no_expiry_disallowed" }] }
      }
    });
    expect(store.rows.profiles[0]!.policyEffectiveAt).toEqual(now);
  });

  it("uses the current policy effective timestamp for expiry compliance instead of original profile age", async () => {
    const store = createMemoryStore();
    const created = await createTokenProfile({
      store,
      sessionToken: "session-token",
      developerTokenConfig: { pepper: "pepper-canary", pepperId: "local-pepper" },
      input: {
        name: "Message writer",
        intendedUse: "Post approved messages from a local CLI",
        preset: "messages_only",
        executionIdentity: "automatic"
      },
      now,
      randomBytes: () => Buffer.alloc(32, 8)
    });

    if (created.kind !== "created") throw new Error("expected created profile");
    store.rows.profiles[0]!.policyEffectiveAt = new Date("2026-03-15T00:00:00.000Z");
    store.rows.profiles[0]!.updatedAt = new Date("2026-03-20T00:00:00.000Z");

    const listed = await listTokenProfiles({
      store,
      globalPolicyStore: policyReader(buildCurrentGlobalTokenProfilePolicy({ expiry: { maximumDays: { readOnly: null, nonDestructive: 30, destructive: 30 } } })),
      sessionToken: "session-token",
      now: new Date("2026-03-20T00:00:00.000Z")
    });

    expect(listed).toMatchObject({
      kind: "profiles",
      profiles: [
        {
          id: created.profile.id,
          globalPolicyStatus: { kind: "inside" }
        }
      ]
    });
  });
});

function dateTime(value: Date | null | undefined): number | null {
  return value instanceof Date ? value.getTime() : null;
}

function policyReader(policy: GlobalTokenProfilePolicy) {
  return {
    async readGlobalTokenProfilePolicy() {
      return { policy, version: 1, updatedByPrismUserId: null, updatedAt: null };
    }
  };
}
