import "server-only";

import { isIP } from "node:net";

export const UNATTRIBUTED_LOCAL_APP_SOURCE = "unattributed";

/**
 * Forwarded addresses are ignored unless a trusted ingress is configured to
 * overwrite them. Invalid or ambiguous trusted headers share the conservative
 * unattributed bucket instead of disabling source limits.
 */
export function resolveLocalAppRequestSource(
  headers: Pick<Headers, "get">,
  trustProxyHeaders = process.env.PRISM_LOCAL_APP_TRUST_PROXY_HEADERS === "1"
): string {
  if (!trustProxyHeaders) return UNATTRIBUTED_LOCAL_APP_SOURCE;

  const forwarded = parseSingleAddress(headers.get("x-forwarded-for"));
  const real = parseSingleAddress(headers.get("x-real-ip"));
  if (forwarded.kind === "invalid" || real.kind === "invalid") return UNATTRIBUTED_LOCAL_APP_SOURCE;
  if (forwarded.kind === "missing" && real.kind === "missing") return UNATTRIBUTED_LOCAL_APP_SOURCE;
  if (forwarded.kind === "valid" && real.kind === "valid" && forwarded.value !== real.value) {
    return UNATTRIBUTED_LOCAL_APP_SOURCE;
  }
  if (forwarded.kind === "valid") return forwarded.value;
  return real.kind === "valid" ? real.value : UNATTRIBUTED_LOCAL_APP_SOURCE;
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
