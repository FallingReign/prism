import "server-only";

import { createHmac, hkdfSync, randomBytes as secureRandomBytes, timingSafeEqual } from "node:crypto";

export const SETUP_BROWSER_TRANSACTION_TTL_MS = 5 * 60 * 1000;
export const SETUP_BROWSER_TRANSACTION_COOKIE_NAME = "prism_setup_browser_transaction";
export const SETUP_BROWSER_TRANSACTION_COOKIE_PATH = "/v1/prism/setup";

// The form proof is a five-minute signed CSRF synchronizer, not authentication.
// It is accepted only with the matching HttpOnly transaction cookie, which is
// cleared after a mutation. The one-use 256-bit host bootstrap capability
// remains the authority for creating a setup session.

type Dependencies = {
  key: Buffer;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
};

export function createSetupBrowserTransactionService(dependencies: Dependencies) {
  if (dependencies.key.byteLength !== 32) throw new Error("setup_browser_transaction_key_invalid");
  const now = dependencies.now ?? (() => new Date());
  const randomBytes = dependencies.randomBytes ?? secureRandomBytes;

  return {
    issue() {
      const expiresAt = new Date(now().getTime() + SETUP_BROWSER_TRANSACTION_TTL_MS);
      const nonceBytes = randomBytes(32);
      if (!Buffer.isBuffer(nonceBytes) || nonceBytes.byteLength !== 32) throw new Error("setup_random_source_invalid");
      const unsigned = `v1.${expiresAt.getTime()}.${nonceBytes.toString("base64url")}`;
      const cookieValue = `${unsigned}.${mac(dependencies.key, `cookie\0${unsigned}`)}`;
      return { cookieValue, proof: `${unsigned}.${mac(dependencies.key, `proof\0${unsigned}`)}`, expiresAt };
    },

    validate(cookieValue: string | undefined, proof: string) {
      const proofParts = parseToken(proof);
      if (!proofParts) return false;
      const expiresAt = Number(proofParts[1]);
      const currentTime = now().getTime();
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= currentTime || expiresAt > currentTime + SETUP_BROWSER_TRANSACTION_TTL_MS) return false;
      const unsigned = proofParts.slice(0, 3).join(".");
      if (!safeEqual(proofParts[3] ?? "", mac(dependencies.key, `proof\0${unsigned}`))) return false;
      if (cookieValue === undefined) return false;
      const cookieParts = parseToken(cookieValue);
      if (!cookieParts || cookieParts.slice(0, 3).join(".") !== unsigned) return false;
      return safeEqual(cookieParts[3] ?? "", mac(dependencies.key, `cookie\0${unsigned}`));
    }
  };
}

function parseToken(value: string): string[] | null {
  if (value.length > 512) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^\d{13}$/.test(parts[1] ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(parts[3] ?? "")) return null;
  return parts;
}

export function deriveSetupBrowserTransactionKey(rootKey: Buffer): Buffer {
  if (rootKey.byteLength !== 32) throw new Error("credential-encryption-key-invalid");
  return Buffer.from(hkdfSync("sha256", rootKey, Buffer.from("prism-setup-browser-transaction:v1"), Buffer.from("setup-browser-synchronizer:v1"), 32));
}

function mac(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
