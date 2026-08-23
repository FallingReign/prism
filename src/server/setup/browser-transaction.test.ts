import { describe, expect, it } from "vitest";

import {
  SETUP_BROWSER_TRANSACTION_TTL_MS,
  createSetupBrowserTransactionService,
  deriveSetupBrowserTransactionKey
} from "./browser-transaction";

describe("setup browser transaction", () => {
  const issuedAt = new Date("2026-08-23T00:00:00.000Z");
  const rootKey = Buffer.alloc(32, 7);

  it("issues distinct cookie and synchronizer values and validates them together", () => {
    const service = createSetupBrowserTransactionService({
      key: deriveSetupBrowserTransactionKey(rootKey),
      now: () => issuedAt,
      randomBytes: (size) => Buffer.alloc(size, 3)
    });
    const transaction = service.issue();

    expect(transaction.cookieValue).not.toContain(transaction.proof);
    expect(transaction.proof).toMatch(/^v1\.\d{13}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(transaction.expiresAt.getTime() - issuedAt.getTime()).toBe(SETUP_BROWSER_TRANSACTION_TTL_MS);
    expect(service.validate(transaction.cookieValue, transaction.proof)).toBe(true);
    expect(service.validate(undefined, transaction.proof)).toBe(false);
    expect(service.validate(transaction.cookieValue, `${transaction.proof.slice(0, -1)}x`)).toBe(false);
    expect(service.validate(`${transaction.cookieValue}x`, transaction.proof)).toBe(false);
  });

  it("rejects expired and malformed values", () => {
    const issuer = createSetupBrowserTransactionService({
      key: deriveSetupBrowserTransactionKey(rootKey),
      now: () => issuedAt,
      randomBytes: (size) => Buffer.alloc(size, 4)
    });
    const transaction = issuer.issue();
    const expired = createSetupBrowserTransactionService({
      key: deriveSetupBrowserTransactionKey(rootKey),
      now: () => new Date(issuedAt.getTime() + SETUP_BROWSER_TRANSACTION_TTL_MS + 1)
    });

    expect(expired.validate(transaction.cookieValue, transaction.proof)).toBe(false);
    expect(expired.validate(undefined, transaction.proof)).toBe(false);
    expect(expired.validate("malformed", transaction.proof)).toBe(false);
    expect(expired.validate(transaction.cookieValue, "malformed")).toBe(false);
  });

  it("derives a purpose-separated key from the credential root", () => {
    expect(deriveSetupBrowserTransactionKey(rootKey)).toHaveLength(32);
    expect(deriveSetupBrowserTransactionKey(rootKey)).not.toEqual(rootKey);
    expect(() => deriveSetupBrowserTransactionKey(Buffer.alloc(31))).toThrow("credential-encryption-key-invalid");
  });
});
