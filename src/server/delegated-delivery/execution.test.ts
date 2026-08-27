import { createHash, generateKeyPairSync } from "node:crypto";

import { calculateJwkThumbprint, exportJWK, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DELEGATED_DELIVERY_LIMITS, type DelegatedDeliveryConfig } from "../config";
import { executeDelegatedSlackMessage } from "./execution";
import type { DelegatedDeliveryStore, DelegatedGrantExecutionBinding } from "./store";

const now = new Date("2026-08-26T05:00:00.000Z");
const issuer = "https://prism.example";
const grantToken = `prism_grant_${"a".repeat(43)}`;
const canonical = JSON.stringify({ blocks: [], channel: "C12345678", text: "Playtest" });

async function fixture(slackResult: { status: number; body: unknown }) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(jwk, "sha256");
  const proof = await new SignJWT({
    htu: `${issuer}/v1/prism/delegations/slack-message/execute`,
    htm: "POST",
    ath: createHash("sha256").update(grantToken, "ascii").digest("base64url"),
    iat: Math.floor(now.getTime() / 1000),
    jti: "execute-service-proof-1",
  }).setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk }).sign(privateKey);
  const binding: DelegatedGrantExecutionBinding = {
    grantId: "ddg_12345678-1234-4123-8123-123456789012",
    requestId: "ddr_12345678-1234-4123-8123-123456789012",
    externalJobId: "job-1",
    revision: 1,
    dpopJkt: jkt,
    prismUserId: "prism-user-1",
    slackConnectionId: "connection-1",
    connectionIdSnapshot: "connection-1",
    slackUserId: "U12345678",
    teamId: "T12345678",
    channelId: "C12345678",
    payloadEnvelope: { algorithm: "local-aes-256-gcm-v1", keyId: "key", iv: "iv", tag: "tag", ciphertext: "cipher" },
    payloadSha256: createHash("sha256").update(canonical).digest("hex"),
    notBefore: new Date(now.getTime() - 1_000),
    expiresAt: new Date(now.getTime() + 60_000),
    state: "active",
    slackTs: null,
    lastErrorCode: null,
  };
  const store = {
    loadGrantExecutionBinding: vi.fn().mockResolvedValue(binding),
    claimGrantExecution: vi.fn().mockResolvedValue({ ...binding, state: "executing" }),
    markGrantUpstreamCalled: vi.fn().mockResolvedValue(undefined),
    finishGrantExecution: vi.fn().mockImplementation(async (input) => ({
      ...binding,
      state: input.state,
      slackTs: input.slackTs ?? null,
      lastErrorCode: input.errorCode ?? null,
    })),
  } as unknown as DelegatedDeliveryStore;
  const config: DelegatedDeliveryConfig = {
    enabled: true,
    issuer,
    clientId: "shg-playtest-delegation",
    callbackUri: "https://playtest.example/api/announcements/delegation/callback",
    clientJwks: [],
    grantPepper: "grant-pepper-with-at-least-32-bytes",
    grantPepperId: "grant-pepper-v1",
    allowInsecureHttp: false,
    trustProxyHeaders: false,
    limits: DEFAULT_DELEGATED_DELIVERY_LIMITS,
  };
  const decision = await executeDelegatedSlackMessage({
    grantToken,
    dpopProof: proof,
    store,
    cipher: { encrypt: vi.fn(), decrypt: vi.fn().mockResolvedValue(canonical) },
    credentialProvider: { getAccessToken: vi.fn().mockResolvedValue({ kind: "available", accessToken: "xoxp-test" }) },
    slackClient: { callMethod: vi.fn().mockResolvedValue(slackResult) },
    config,
    now,
    randomId: () => "lease-1",
  });
  return { decision, store };
}

describe("delegated Slack execution", () => {
  it("delivers the immutable approved payload once as the bound user", async () => {
    const { decision, store } = await fixture({
      status: 200,
      body: { ok: true, channel: "C12345678", ts: "1787710000.000100" },
    });
    expect(decision).toMatchObject({ kind: "success", body: { state: "sent", slack_ts: "1787710000.000100" } });
    expect(store.markGrantUpstreamCalled).toHaveBeenCalledOnce();
    expect(store.finishGrantExecution).toHaveBeenCalledWith(expect.objectContaining({ state: "sent", upstreamCalled: true }));
  });

  it("marks every Slack 5xx as outcome unknown instead of retrying", async () => {
    const { decision, store } = await fixture({ status: 500, body: { ok: false, error: "internal_error" } });
    expect(decision).toMatchObject({ kind: "success", body: { state: "outcome_unknown" } });
    expect(store.finishGrantExecution).toHaveBeenCalledWith(expect.objectContaining({ state: "outcome_unknown" }));
  });
});
