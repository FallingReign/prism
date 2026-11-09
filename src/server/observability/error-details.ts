/**
 * Prism logs error classes, never error text: messages from `pg` and the Slack
 * SDKs routinely embed connection strings and tokens. This keeps that posture
 * while exposing the few enum-like fields that identify *why* a call failed,
 * such as `ECONNREFUSED` against an unreachable database.
 */

const SAFE_TEXT_FIELDS = ["code", "syscall", "address"] as const;
const SAFE_NUMERIC_FIELDS = ["port", "errno"] as const;
const MAX_SAFE_TEXT_LENGTH = 64;

export type ErrorLogDetails = {
  errorName: string;
  code?: string;
  syscall?: string;
  address?: string;
  port?: number;
  errno?: number;
};

export function describeErrorForLog(error: unknown): ErrorLogDetails {
  if (!(error instanceof Error)) return { errorName: typeof error };

  const candidate = error as unknown as Record<string, unknown>;
  const details: ErrorLogDetails = { errorName: error.name };

  for (const field of SAFE_TEXT_FIELDS) {
    const value = toEnumLikeText(candidate[field]);
    if (value !== null) details[field] = value;
  }
  for (const field of SAFE_NUMERIC_FIELDS) {
    const value = candidate[field];
    if (typeof value === "number" && Number.isFinite(value)) details[field] = value;
  }

  return details;
}

/** Free text can carry secrets, so only short single-token values are kept. */
function toEnumLikeText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_SAFE_TEXT_LENGTH) return null;
  return /\s/.test(value) ? null : value;
}
