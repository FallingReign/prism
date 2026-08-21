import "server-only";

import { isIP } from "node:net";

export const UNATTRIBUTED_DELEGATED_SOURCE = "unattributed";

/**
 * Forwarded addresses are accepted only when a deployment explicitly declares
 * that a trusted ingress overwrites them and direct origin access is blocked.
 * In trusted mode, missing, duplicated, malformed, or disagreeing headers fail
 * closed so source limits cannot silently disappear because of proxy drift.
 */
export function resolveDelegatedDeliverySource(
  headers: Pick<Headers, "get">,
  trustProxyHeaders: boolean
): string | null {
  if (!trustProxyHeaders) return UNATTRIBUTED_DELEGATED_SOURCE;

  const forwarded = parseSingleAddress(headers.get("x-forwarded-for"));
  const real = parseSingleAddress(headers.get("x-real-ip"));
  if (forwarded.kind === "invalid" || real.kind === "invalid") return null;
  if (forwarded.kind === "missing" && real.kind === "missing") return null;
  if (
    forwarded.kind === "valid" &&
    real.kind === "valid" &&
    forwarded.value !== real.value
  ) {
    return null;
  }
  if (forwarded.kind === "valid") return forwarded.value;
  return real.kind === "valid" ? real.value : null;
}

type ParsedAddress =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; value: string };

function parseSingleAddress(value: string | null): ParsedAddress {
  if (value === null) return { kind: "missing" };
  if (value.length > 64 || value.includes(",")) return { kind: "invalid" };
  const normalized = value.trim().toLowerCase();
  if (!normalized || !isIP(normalized)) return { kind: "invalid" };
  return { kind: "valid", value: normalized };
}
