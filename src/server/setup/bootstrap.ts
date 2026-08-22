import "server-only";

import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes as secureRandomBytes,
  randomUUID
} from "node:crypto";

export const SETUP_PURPOSE = "initial_slack_configuration" as const;
export const SETUP_BOOTSTRAP_CAPABILITY_BYTES = 32;
export const SETUP_SESSION_TOKEN_BYTES = 32;
export const SETUP_BOOTSTRAP_TTL_MS = 15 * 60 * 1000;
export const SETUP_SESSION_TTL_MS = 30 * 60 * 1000;
export const SETUP_EXCHANGE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const SETUP_EXCHANGE_RATE_LIMIT_MAX_ATTEMPTS_PER_SOURCE = 20;
export const SETUP_EXCHANGE_GLOBAL_CIRCUIT_BREAKER_MAX_ATTEMPTS = 1000;

export type SetupPurpose = typeof SETUP_PURPOSE;

export type SetupBootstrapCapabilityRecord = {
  id: string;
  purpose: SetupPurpose;
  recovery: boolean;
  createdAt: Date;
  expiresAt: Date;
};

export type SetupSessionContext = {
  id: string;
  bootstrapTokenId: string;
  purpose: SetupPurpose;
  recovery: boolean;
  expiresAt: Date;
  pendingConfigurationVersionId: string | null;
};

export type SetupConfigurationAdminClaim = {
  recovery: boolean;
};

export type SetupBootstrapStore = {
  mintCapability(input: SetupBootstrapCapabilityRecord & { tokenHash: string }): Promise<SetupBootstrapCapabilityRecord>;
  consumeCapability(input: {
    tokenHash: string;
    setupSessionId: string;
    sessionTokenHash: string;
    purpose: SetupPurpose;
    requestId: string;
    sourceRateLimitBucketKey: string | null;
    now: Date;
    expiresAt: Date;
  }): Promise<SetupSessionContext | null>;
  resolveSession(input: { sessionTokenHash: string; now: Date }): Promise<SetupSessionContext | null>;
  /**
   * Transaction hook for the Slack callback. Construct the store with the
   * callback transaction's Database so this claim commits with activation,
   * Slack credential/session persistence, and audit.
   */
  claimSessionAndConfigurationAdmin(input: {
    setupSessionId: string;
    configurationVersionId: string;
    prismUserId: string;
    now: Date;
  }): Promise<SetupConfigurationAdminClaim | null>;
};

export type SetupBootstrapService = {
  mintCapability(input?: { recovery?: boolean }): Promise<{
    code: string;
    expiresAt: Date;
    recovery: boolean;
  }>;
  exchangeCapability(input: { code: string; requestId: string; sourceAddress?: string }): Promise<{
    sessionToken: string;
    session: SetupSessionContext;
  } | null>;
  resolveSession(sessionToken: string): Promise<SetupSessionContext | null>;
};

export class SetupBootstrapRecoveryRequiredError extends Error {
  constructor() {
    super("setup_bootstrap_recovery_required");
    this.name = "SetupBootstrapRecoveryRequiredError";
  }
}

export class SetupBootstrapStoreUnavailableError extends Error {
  constructor() {
    super("setup_bootstrap_store_unavailable");
    this.name = "SetupBootstrapStoreUnavailableError";
  }
}

export class SetupBootstrapRateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("setup_bootstrap_rate_limited");
    this.name = "SetupBootstrapRateLimitedError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

type SetupBootstrapDependencies = {
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  randomId?: () => string;
  sourceHashKey?: Buffer | string;
};

export function createSetupBootstrapService(
  store: SetupBootstrapStore,
  dependencies: SetupBootstrapDependencies = {}
): SetupBootstrapService {
  const now = dependencies.now ?? (() => new Date());
  const randomBytes = dependencies.randomBytes ?? secureRandomBytes;
  const randomId = dependencies.randomId ?? randomUUID;

  return {
    async mintCapability({ recovery = false } = {}) {
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + SETUP_BOOTSTRAP_TTL_MS);
      const code = createRandomToken(randomBytes, SETUP_BOOTSTRAP_CAPABILITY_BYTES);
      await store.mintCapability({
        id: randomId(),
        tokenHash: hashSetupSecret(code),
        purpose: SETUP_PURPOSE,
        recovery,
        createdAt,
        expiresAt
      });
      return { code, expiresAt, recovery };
    },

    async exchangeCapability({ code, requestId, sourceAddress }) {
      if (!isBoundedText(code, 512) || !isBoundedText(requestId, 120)) return null;
      if (sourceAddress !== undefined && !isBoundedText(sourceAddress, 64)) return null;
      const issuedAt = now();
      const sessionToken = createRandomToken(randomBytes, SETUP_SESSION_TOKEN_BYTES);
      const session = await store.consumeCapability({
        tokenHash: hashSetupSecret(code),
        setupSessionId: randomId(),
        sessionTokenHash: hashSetupSecret(sessionToken),
        purpose: SETUP_PURPOSE,
        requestId,
        sourceRateLimitBucketKey:
          sourceAddress === undefined
            ? null
            : setupRateLimitSourceBucketKey(sourceAddress, dependencies.sourceHashKey),
        now: issuedAt,
        expiresAt: new Date(issuedAt.getTime() + SETUP_SESSION_TTL_MS)
      });
      return session ? { sessionToken, session } : null;
    },

    async resolveSession(sessionToken) {
      if (!isBoundedText(sessionToken, 512)) return null;
      return store.resolveSession({ sessionTokenHash: hashSetupSecret(sessionToken), now: now() });
    }
  };
}

export function hashSetupSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function deriveSetupRateLimitSourceKey(rootKey: Buffer): Buffer {
  if (rootKey.byteLength !== 32) throw new Error("credential-encryption-key-invalid");
  return Buffer.from(
    hkdfSync(
      "sha256",
      rootKey,
      Buffer.from("prism-setup-rate-limit-source:v1", "utf8"),
      Buffer.from("setup-capability-source-hmac:v1", "utf8"),
      32
    )
  );
}

function setupRateLimitSourceBucketKey(
  sourceAddress: string,
  sourceHashKey: Buffer | string | undefined
): string {
  if (sourceHashKey === undefined) throw new SetupBootstrapStoreUnavailableError();
  return `source:${createHmac("sha256", sourceHashKey).update(sourceAddress, "utf8").digest("hex")}`;
}

function createRandomToken(randomBytes: (size: number) => Buffer, size: number): string {
  const bytes = randomBytes(size);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== size) {
    throw new Error("setup_random_source_invalid");
  }
  return bytes.toString("base64url");
}

function isBoundedText(value: string, maximumLength: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}
