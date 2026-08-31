import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export const UNATTRIBUTED_REMOTE_CODEX_SOURCE = "unattributed";

export function resolveRemoteCodexPairingSource(
  headers: Pick<Headers, "get">,
  trustProxyHeaders: boolean
): string | null {
  if (!trustProxyHeaders) return UNATTRIBUTED_REMOTE_CODEX_SOURCE;

  const forwarded = parseSingleAddress(headers.get("x-forwarded-for"));
  const real = parseSingleAddress(headers.get("x-real-ip"));
  if (forwarded.kind === "invalid" || real.kind === "invalid") return null;
  if (forwarded.kind === "missing" && real.kind === "missing") return null;
  if (
    forwarded.kind === "valid" &&
    real.kind === "valid" &&
    forwarded.value !== real.value
  ) return null;
  if (forwarded.kind === "valid") return forwarded.value;
  return real.kind === "valid" ? real.value : null;
}

export function remoteCodexSourceKey(source: string, rootKeyBase64: string): string {
  const key = Buffer.from(rootKeyBase64, "base64");
  if (key.byteLength !== 32) throw new Error("setup-required:PRISM_CREDENTIAL_ENCRYPTION_KEY");
  return createHmac("sha256", key)
    .update(`prism-remote-codex-pairing-source-v1\n${source}`, "utf8")
    .digest("hex");
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
