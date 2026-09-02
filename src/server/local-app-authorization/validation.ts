import type { BeginLocalAppAuthorizationInput } from "./types";

const BEGIN_KEYS = [
  "clientId",
  "displayName",
  "intendedUse",
  "requestedPreset",
  "executionIdentity"
] as const;
const BEGIN_KEYS_WITH_INBOUND = [...BEGIN_KEYS, "inbound"] as const;
const TOKEN_KEYS = ["clientId", "deviceCode"] as const;
const RESERVED_CLIENT_IDS = new Set(["shg-playtest", "shg-playtest-delegation"]);

export function parseBeginInput(value: unknown): BeginLocalAppAuthorizationInput | null {
  if (!hasExactKeys(value, BEGIN_KEYS) && !hasExactKeys(value, BEGIN_KEYS_WITH_INBOUND)) return null;
  if (!validClientId(value.clientId) || RESERVED_CLIENT_IDS.has(value.clientId)) return null;
  const displayName = boundedText(value.displayName, 1, 80);
  const intendedUse = boundedText(value.intendedUse, 1, 240);
  if (!displayName || !intendedUse) return null;
  if (value.requestedPreset !== "messages_only" || value.executionIdentity !== "user") return null;
  const inbound = "inbound" in value ? parseInbound(value.inbound) : { blockActions: false };
  if (!inbound) return null;
  return {
    clientId: value.clientId,
    displayName,
    intendedUse,
    requestedPreset: "messages_only",
    executionIdentity: "user",
    inbound
  };
}

function parseInbound(value: unknown): { blockActions: boolean } | null {
  if (!hasExactKeys(value, ["blockActions"] as const) || typeof value.blockActions !== "boolean") return null;
  return { blockActions: value.blockActions };
}

export function parseTokenInput(value: unknown): { clientId: string; deviceCode: string } | null {
  if (!hasExactKeys(value, TOKEN_KEYS)) return null;
  if (!validClientId(value.clientId) || !validDeviceCode(value.deviceCode)) return null;
  return { clientId: value.clientId, deviceCode: value.deviceCode };
}

export function canonicalUserCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const canonical = value.trim().toUpperCase();
  return /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(canonical) ? canonical : null;
}

export function validDeviceCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function validClientId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function boundedText(value: unknown, minimum: number, maximum: number): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const text = value.trim();
  return text.length >= minimum && text.length <= maximum ? text : null;
}

function hasExactKeys<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys
): value is Record<Keys[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
