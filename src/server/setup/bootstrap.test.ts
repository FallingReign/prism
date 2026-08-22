import { describe, expect, it, vi } from "vitest";

import {
  SETUP_BOOTSTRAP_CAPABILITY_BYTES,
  SETUP_BOOTSTRAP_TTL_MS,
  SETUP_SESSION_TOKEN_BYTES,
  SETUP_SESSION_TTL_MS,
  createSetupBootstrapService,
  deriveSetupRateLimitSourceKey,
  type SetupBootstrapStore,
  type SetupSessionContext
} from "./bootstrap";

describe("setup bootstrap service", () => {
  it("mints a 32-byte one-time capability and gives the store only its SHA-256 hash", async () => {
    const store = createStore();
    const randomBytes = vi.fn((size: number) => Buffer.alloc(size, 0x2a));
    const now = new Date("2026-08-23T01:00:00.000Z");
    const service = createSetupBootstrapService(store, {
      now: () => now,
      randomBytes,
      randomId: () => "bootstrap_1"
    });

    const result = await service.mintCapability({ recovery: false });

    expect(randomBytes).toHaveBeenCalledWith(SETUP_BOOTSTRAP_CAPABILITY_BYTES);
    expect(Buffer.from(result.code, "base64url")).toHaveLength(32);
    expect(result.expiresAt).toEqual(new Date(now.getTime() + SETUP_BOOTSTRAP_TTL_MS));
    expect(store.mintCapability).toHaveBeenCalledWith({
      id: "bootstrap_1",
      tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      purpose: "initial_slack_configuration",
      recovery: false,
      createdAt: now,
      expiresAt: result.expiresAt
    });
    expect(JSON.stringify(vi.mocked(store.mintCapability).mock.calls)).not.toContain(result.code);
  });

  it("atomically exchanges a capability for a different 32-byte setup-session token", async () => {
    const now = new Date("2026-08-23T01:05:00.000Z");
    const session: SetupSessionContext = {
      id: "setup_session_1",
      bootstrapTokenId: "bootstrap_1",
      purpose: "initial_slack_configuration",
      recovery: false,
      expiresAt: new Date(now.getTime() + SETUP_SESSION_TTL_MS),
      pendingConfigurationVersionId: null
    };
    const store = createStore({ consumeCapability: vi.fn().mockResolvedValue(session) });
    const randomBytes = vi
      .fn<(size: number) => Buffer>()
      .mockReturnValueOnce(Buffer.alloc(SETUP_SESSION_TOKEN_BYTES, 0x3b));
    const service = createSetupBootstrapService(store, {
      now: () => now,
      randomBytes,
      randomId: () => "setup_session_1"
    });

    const result = await service.exchangeCapability({ code: "valid-bootstrap-code", requestId: "request_1" });

    expect(result).not.toBeNull();
    expect(Buffer.from(result!.sessionToken, "base64url")).toHaveLength(32);
    expect(result!.session).toEqual(session);
    expect(store.consumeCapability).toHaveBeenCalledWith({
      tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      setupSessionId: "setup_session_1",
      sessionTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      requestId: "request_1",
      purpose: "initial_slack_configuration",
      sourceRateLimitBucketKey: null,
      now,
      expiresAt: new Date(now.getTime() + SETUP_SESSION_TTL_MS)
    });
    const storedArguments = JSON.stringify(vi.mocked(store.consumeCapability).mock.calls);
    expect(storedArguments).not.toContain("valid-bootstrap-code");
    expect(storedArguments).not.toContain(result!.sessionToken);
  });

  it("turns an attributed request source into a root-key-derived HMAC before storage", async () => {
    const store = createStore();
    const sourceAddress = "2001:db8::42";
    const rootKey = Buffer.alloc(32, 0x6c);
    const sourceHashKey = deriveSetupRateLimitSourceKey(rootKey);
    expect(sourceHashKey.equals(rootKey)).toBe(false);
    expect(deriveSetupRateLimitSourceKey(rootKey).equals(sourceHashKey)).toBe(true);
    expect(deriveSetupRateLimitSourceKey(Buffer.alloc(32, 0x6d)).equals(sourceHashKey)).toBe(false);
    const service = createSetupBootstrapService(store, {
      randomBytes: (size) => Buffer.alloc(size, 0x22),
      randomId: () => "setup_session_source",
      sourceHashKey
    });

    await service.exchangeCapability({
      code: "valid-bootstrap-code",
      requestId: "request_source",
      sourceAddress
    });

    expect(store.consumeCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRateLimitBucketKey: expect.stringMatching(/^source:[0-9a-f]{64}$/)
      })
    );
    expect(JSON.stringify(vi.mocked(store.consumeCapability).mock.calls)).not.toContain(sourceAddress);
  });

  it("does not create a low-volume source bucket for unattributed requests", async () => {
    const store = createStore();
    const service = createSetupBootstrapService(store, {
      randomBytes: (size) => Buffer.alloc(size, 0x23),
      randomId: () => "setup_session_unattributed"
    });

    await service.exchangeCapability({ code: "valid-bootstrap-code", requestId: "request_unattributed" });

    expect(store.consumeCapability).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRateLimitBucketKey: null })
    );
  });

  it("returns the same generic null result for malformed and rejected capabilities", async () => {
    const store = createStore({ consumeCapability: vi.fn().mockResolvedValue(null) });
    const service = createSetupBootstrapService(store, {
      randomBytes: (size) => Buffer.alloc(size, 0x11),
      randomId: () => "setup_session_1"
    });

    await expect(service.exchangeCapability({ code: "", requestId: "request_1" })).resolves.toBeNull();
    await expect(service.exchangeCapability({ code: "wrong", requestId: "request_2" })).resolves.toBeNull();
  });

  it("resolves setup sessions by hash without passing the browser token to the store", async () => {
    const context: SetupSessionContext = {
      id: "setup_session_1",
      bootstrapTokenId: "bootstrap_1",
      purpose: "initial_slack_configuration",
      recovery: true,
      expiresAt: new Date("2026-08-23T01:30:00.000Z"),
      pendingConfigurationVersionId: "configuration_1"
    };
    const store = createStore({ resolveSession: vi.fn().mockResolvedValue(context) });
    const service = createSetupBootstrapService(store);

    await expect(service.resolveSession("browser-session-token")).resolves.toEqual(context);
    expect(store.resolveSession).toHaveBeenCalledWith({
      sessionTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      now: expect.any(Date)
    });
    expect(JSON.stringify(vi.mocked(store.resolveSession).mock.calls)).not.toContain("browser-session-token");
  });
});

function createStore(overrides: Partial<SetupBootstrapStore> = {}): SetupBootstrapStore {
  return {
    mintCapability: vi.fn().mockImplementation(async (input) => input),
    consumeCapability: vi.fn().mockResolvedValue(null),
    resolveSession: vi.fn().mockResolvedValue(null),
    claimSessionAndConfigurationAdmin: vi.fn().mockResolvedValue(null),
    ...overrides
  };
}
