import "server-only";

import { timingSafeEqual } from "node:crypto";

import {
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  type JWTPayload
} from "jose";

import { DELEGATED_CLIENT_PROOF_AUDIENCE } from "./types";
import { sha256Hex } from "./validation";

export type RegisteredDelegationJwk = JWK & {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
};

export type VerifiedProofReplay = {
  jkt: string;
  jtiHash: string;
  expiresAt: Date;
};

export async function verifyDelegatedClientProof(input: {
  proof: string | null;
  registeredJwks: RegisteredDelegationJwk[];
  clientId: string;
  expectedHtu: string;
  method: string;
  rawBody: string;
  now?: Date;
  clockSkewSeconds: number;
  proofLifetimeSeconds: number;
}): Promise<{ kind: "valid"; replay: VerifiedProofReplay } | { kind: "invalid" }> {
  if (!input.proof || input.proof.length > 4096) return invalid();
  try {
    const header = decodeProtectedHeader(input.proof);
    if (
      !hasExactKeys(header, ["alg", "kid", "typ"]) ||
      header.alg !== "ES256" ||
      header.typ !== "prism-client-proof+jwt" ||
      typeof header.kid !== "string"
    ) {
      return invalid();
    }
    const registered = input.registeredJwks.find((jwk) => jwk.kid === header.kid);
    if (!registered || !isPublicP256Jwk(registered)) return invalid();
    const verification = await compactVerify(input.proof, await importJWK(registered, "ES256"), {
      algorithms: ["ES256"]
    });
    const claims = parseJsonObject(verification.payload);
    if (!claims || !hasExactKeys(claims, ["aud", "body_sha256", "exp", "htm", "htu", "iat", "iss", "jti", "sub"])) {
      return invalid();
    }
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const iat = integerClaim(claims.iat);
    const exp = integerClaim(claims.exp);
    if (
      claims.iss !== input.clientId ||
      claims.sub !== input.clientId ||
      claims.aud !== DELEGATED_CLIENT_PROOF_AUDIENCE ||
      claims.htu !== normalizeHtu(input.expectedHtu) ||
      claims.htm !== input.method.toUpperCase() ||
      claims.body_sha256 !== sha256Hex(Buffer.from(input.rawBody, "utf8")) ||
      !validJti(claims.jti) ||
      iat === null ||
      exp === null ||
      exp <= iat ||
      exp - iat > input.proofLifetimeSeconds ||
      iat > nowSeconds + input.clockSkewSeconds ||
      exp < nowSeconds - input.clockSkewSeconds
    ) {
      return invalid();
    }
    const jkt = await calculateJwkThumbprint(publicThumbprintJwk(registered), "sha256");
    return {
      kind: "valid",
      replay: {
        jkt,
        jtiHash: sha256Hex(`client-proof:${input.clientId}:${claims.jti}`),
        expiresAt: new Date((exp + input.clockSkewSeconds) * 1000)
      }
    };
  } catch {
    return invalid();
  }
}

export async function verifyDelegatedExchangeDpop(input: {
  proof: string | null;
  expectedJkt: string;
  expectedHtu: string;
  now?: Date;
  clockSkewSeconds: number;
  proofLifetimeSeconds: number;
}): Promise<{ kind: "valid"; replay: VerifiedProofReplay } | { kind: "invalid" }> {
  if (!input.proof || input.proof.length > 4096) return invalid();
  try {
    const header = decodeProtectedHeader(input.proof);
    if (
      !hasExactKeys(header, ["alg", "jwk", "typ"]) ||
      header.alg !== "ES256" ||
      header.typ !== "dpop+jwt" ||
      !isPublicP256Jwk(header.jwk)
    ) {
      return invalid();
    }
    const verification = await compactVerify(input.proof, await importJWK(header.jwk, "ES256"), {
      algorithms: ["ES256"]
    });
    const claims = parseJsonObject(verification.payload);
    if (!claims || !hasExactKeys(claims, ["htm", "htu", "iat", "jti"])) return invalid();
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const iat = integerClaim(claims.iat);
    const jkt = await calculateJwkThumbprint(publicThumbprintJwk(header.jwk), "sha256");
    if (
      !constantTimeTextEqual(jkt, input.expectedJkt) ||
      claims.htu !== normalizeHtu(input.expectedHtu) ||
      claims.htm !== "POST" ||
      !validJti(claims.jti) ||
      iat === null ||
      iat > nowSeconds + input.clockSkewSeconds ||
      iat < nowSeconds - input.proofLifetimeSeconds - input.clockSkewSeconds
    ) {
      return invalid();
    }
    return {
      kind: "valid",
      replay: {
        jkt,
        jtiHash: sha256Hex(`dpop:${jkt}:${claims.jti}`),
        expiresAt: new Date((iat + input.proofLifetimeSeconds + input.clockSkewSeconds) * 1000)
      }
    };
  } catch {
    return invalid();
  }
}

export function normalizeHtu(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search) throw new Error("invalid-proof-url");
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  return `${url.origin}${url.pathname}`;
}

function parseJsonObject(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function hasExactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function isPublicP256Jwk(value: unknown): value is RegisteredDelegationJwk {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const jwk = value as Record<string, unknown>;
  if ("d" in jwk || "p" in jwk || "q" in jwk || "k" in jwk) return false;
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" && /^[A-Za-z0-9_-]{43}$/.test(jwk.x) &&
    typeof jwk.y === "string" && /^[A-Za-z0-9_-]{43}$/.test(jwk.y) &&
    (jwk.alg === undefined || jwk.alg === "ES256") &&
    (jwk.use === undefined || jwk.use === "sig") &&
    (jwk.kid === undefined || (typeof jwk.kid === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(jwk.kid)))
  );
}

function publicThumbprintJwk(jwk: JWK): JWK {
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

function integerClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function validJti(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(value);
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function invalid(): { kind: "invalid" } {
  return { kind: "invalid" };
}
