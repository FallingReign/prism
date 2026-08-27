import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";
import { calculateJwkThumbprint, exportJWK, SignJWT } from "jose";

import {
  verifyDelegatedClientProof,
  verifyDelegatedExecutionDpop,
  verifyDelegatedExchangeDpop,
  type RegisteredDelegationJwk
} from "./proof";
import { sha256Hex } from "./validation";

const now = new Date("2026-08-22T00:00:00.000Z");
const clientId = "shg-playtest-delegation";
const requestHtu = "https://prism.example/v1/prism/delegations/slack-message/requests";
const tokenHtu = "https://prism.example/v1/prism/delegations/slack-message/token";
const executeHtu = "https://prism.example/v1/prism/delegations/slack-message/execute";

async function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = await exportJWK(publicKey) as RegisteredDelegationJwk;
  publicJwk.kid = "playtest-key-v1";
  return { privateKey, publicJwk };
}

describe("delegated client and DPoP proofs", () => {
  it("verifies exact ES256 registered-client claims and derives a hash-only replay key", async () => {
    const { privateKey, publicJwk } = await keyMaterial();
    const rawBody = '{"client_id":"shg-playtest-delegation"}';
    const proof = await new SignJWT({
      iss: clientId,
      sub: clientId,
      aud: "urn:prism:delegated-slack-message:v1",
      htu: requestHtu,
      htm: "POST",
      body_sha256: sha256Hex(rawBody),
      iat: 1_787_356_800,
      exp: 1_787_356_860,
      jti: "client-proof-jti-1"
    }).setProtectedHeader({ typ: "prism-client-proof+jwt", alg: "ES256", kid: publicJwk.kid }).sign(privateKey);

    const result = await verifyDelegatedClientProof({
      proof,
      registeredJwks: [publicJwk],
      clientId,
      expectedHtu: requestHtu,
      method: "POST",
      rawBody,
      now,
      clockSkewSeconds: 60,
      proofLifetimeSeconds: 60
    });
    expect(result).toMatchObject({
      kind: "valid",
      replay: { jtiHash: expect.stringMatching(/^[a-f0-9]{64}$/) }
    });
    expect(JSON.stringify(result)).not.toContain("client-proof-jti-1");
  });

  it.each([
    ["wrong body", { body: "different" }],
    ["wrong method", { method: "DELETE" }],
    ["wrong URL", { htu: `${requestHtu}/extra` }],
    ["expired", { now: new Date("2026-08-22T00:02:01.000Z") }]
  ])("rejects %s", async (_label, rawOverride) => {
    const override = rawOverride as Partial<{ body: string; method: string; htu: string; now: Date }>;
    const { privateKey, publicJwk } = await keyMaterial();
    const rawBody = "{}";
    const proof = await new SignJWT({
      iss: clientId, sub: clientId, aud: "urn:prism:delegated-slack-message:v1",
      htu: override.htu ?? requestHtu, htm: "POST", body_sha256: sha256Hex(rawBody),
      iat: 1_787_356_800, exp: 1_787_356_860, jti: "client-proof-jti-2"
    }).setProtectedHeader({ typ: "prism-client-proof+jwt", alg: "ES256", kid: publicJwk.kid }).sign(privateKey);
    await expect(verifyDelegatedClientProof({
      proof, registeredJwks: [publicJwk], clientId, expectedHtu: requestHtu,
      method: override.method ?? "POST", rawBody: override.body ?? rawBody,
      now: override.now ?? now, clockSkewSeconds: 60, proofLifetimeSeconds: 60
    })).resolves.toEqual({ kind: "invalid" });
  });

  it("verifies exchange DPoP against the request thumbprint and rejects private/extra claims", async () => {
    const { privateKey, publicJwk } = await keyMaterial();
    const thumbprintJwk = { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y };
    const jkt = await calculateJwkThumbprint(thumbprintJwk, "sha256");
    const proof = await new SignJWT({ htu: tokenHtu, htm: "POST", iat: 1_787_356_800, jti: "dpop-proof-jti-1" })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: thumbprintJwk })
      .sign(privateKey);

    await expect(verifyDelegatedExchangeDpop({
      proof, expectedJkt: jkt, expectedHtu: tokenHtu, now,
      clockSkewSeconds: 60, proofLifetimeSeconds: 60
    })).resolves.toMatchObject({ kind: "valid", replay: { jkt } });

    await expect(verifyDelegatedExchangeDpop({
      proof, expectedJkt: "x".repeat(43), expectedHtu: tokenHtu, now,
      clockSkewSeconds: 60, proofLifetimeSeconds: 60
    })).resolves.toEqual({ kind: "invalid" });

    const extraClaim = await new SignJWT({ htu: tokenHtu, htm: "POST", iat: 1_787_356_800, jti: "dpop-proof-jti-2", actorSubject: "attacker" })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: thumbprintJwk })
      .sign(privateKey);
    await expect(verifyDelegatedExchangeDpop({
      proof: extraClaim, expectedJkt: jkt, expectedHtu: tokenHtu, now,
      clockSkewSeconds: 60, proofLifetimeSeconds: 60
    })).resolves.toEqual({ kind: "invalid" });
  });

  it("binds execution DPoP to the exact grant token with ath", async () => {
    const { privateKey, publicJwk } = await keyMaterial();
    const thumbprintJwk = { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y };
    const jkt = await calculateJwkThumbprint(thumbprintJwk, "sha256");
    const grantToken = `prism_grant_${"a".repeat(43)}`;
    const proof = await new SignJWT({
      htu: executeHtu,
      htm: "POST",
      ath: createHash("sha256").update(grantToken, "ascii").digest("base64url"),
      iat: 1_787_356_800,
      jti: "dpop-execute-jti-1"
    }).setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: thumbprintJwk }).sign(privateKey);
    await expect(verifyDelegatedExecutionDpop({
      proof, grantToken, expectedJkt: jkt, expectedHtu: executeHtu, now,
      clockSkewSeconds: 60, proofLifetimeSeconds: 60
    })).resolves.toMatchObject({ kind: "valid", replay: { jkt } });
    await expect(verifyDelegatedExecutionDpop({
      proof, grantToken: `prism_grant_${"b".repeat(43)}`,
      expectedJkt: jkt, expectedHtu: executeHtu, now,
      clockSkewSeconds: 60, proofLifetimeSeconds: 60
    })).resolves.toEqual({ kind: "invalid" });
  });
});
