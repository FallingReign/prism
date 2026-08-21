import "server-only";

import { isIP } from "node:net";

export const UNATTRIBUTED_OIDC_SOURCE = "unattributed";

/**
 * Proxy-derived addresses are accepted only behind an explicitly configured
 * trusted ingress. That ingress must overwrite, rather than append to,
 * client-supplied forwarding headers and must prevent direct origin access.
 */
export function resolveOidcAuthorizationSource(
  headers: Pick<Headers, "get">,
  trustProxyHeaders: boolean
): string {
  if (!trustProxyHeaders) return UNATTRIBUTED_OIDC_SOURCE;

  const forwardedFor = headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  if (forwardedFor && isIP(forwardedFor)) return forwardedFor.toLowerCase();

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp && isIP(realIp)) return realIp.toLowerCase();

  return UNATTRIBUTED_OIDC_SOURCE;
}
