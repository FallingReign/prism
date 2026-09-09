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

async function fixture(slackResult: { status: number; body: unknown }, executionMode: "user" | "bot" = "user", credentialAvailable = true) {
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
    executionMode,
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
  const slackClient = { callMethod: vi.fn().mockResolvedValue(slackResult) };
  const credentialProvider = { getAccessToken: vi.fn().mockResolvedValue(credentialAvailable
    ? { kind: "available", accessToken: executionMode === "bot" ? "xoxb-test" : "xoxp-test" }
    : { kind: "unavailable", errorClass: "credential_missing" }) };
  const decision = await executeDelegatedSlackMessage({
    grantToken,
    dpopProof: proof,
    store,
    cipher: { encrypt: vi.fn(), decrypt: vi.fn().mockResolvedValue(canonical) },
    credentialProvider,
    slackClient,
    config,
    now,
    randomId: () => "lease-1",
  });
  return { decision, store, slackClient, credentialProvider };
}

describe("delegated Slack execution", () => {
  it("delivers the immutable approved payload once as the bound user", async () => {
    const { decision, store, slackClient } = await fixture({
      status: 200,
      body: { ok: true, channel: "C12345678", ts: "1787710000.000100" },
    });
    expect(decision).toMatchObject({ kind: "success", body: { state: "sent", slack_ts: "1787710000.000100" } });
    expect(store.markGrantUpstreamCalled).toHaveBeenCalledOnce();
    expect(store.finishGrantExecution).toHaveBeenCalledWith(expect.objectContaining({ state: "sent", upstreamCalled: true }));
    expect(slackClient.callMethod).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        channel: "C12345678",
        client_context_team_id: "T12345678"
      })
    }));
  });

  it("uses the approved bot credential and records the bot without changing the approving person", async () => {
    const { decision, slackClient, credentialProvider } = await fixture({ status: 200, body: { ok: true, channel: "C12345678", ts: "1787710000.000100" } }, "bot");
    expect(credentialProvider.getAccessToken).toHaveBeenCalledExactlyOnceWith({ connectionId: "connection-1", kind: "bot" });
    expect(slackClient.callMethod).toHaveBeenCalledWith(expect.objectContaining({ executionMode: "bot", accessToken: "xoxb-test" }));
    expect(decision).toMatchObject({ kind: "success", body: { state: "sent", execution_mode: "bot", slack_user_id: "U12345678" } });
  });

  it("does not fall back to Me when the approved bot credential is unavailable", async () => {
    const { decision, slackClient, credentialProvider } = await fixture({ status: 200, body: { ok: true } }, "bot", false);
    expect(credentialProvider.getAccessToken).toHaveBeenCalledExactlyOnceWith({ connectionId: "connection-1", kind: "bot" });
    expect(slackClient.callMethod).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ kind: "success", body: { state: "failed", execution_mode: "bot", error: "credential_missing" } });
  });

  it("marks every Slack 5xx as outcome unknown instead of retrying", async () => {
    const { decision, store } = await fixture({ status: 500, body: { ok: false, error: "internal_error" } });
    expect(decision).toMatchObject({ kind: "success", body: { state: "outcome_unknown" } });
    expect(store.finishGrantExecution).toHaveBeenCalledWith(expect.objectContaining({ state: "outcome_unknown" }));
  });
});
