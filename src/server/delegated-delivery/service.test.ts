import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { calculateJwkThumbprint, exportJWK, SignJWT } from "jose";

import type { DelegatedDeliveryConfig, DelegatedDeliveryPublicJwk } from "../config";
import { createLocalAesGcmCredentialCipher } from "../credentials/encryption";
import type { DelegatedDeliveryStore } from "./store";
import {
  approveDelegationRequest,
  createDelegationRequest,
  exchangeDelegatedAuthorizationCode,
  resolveDelegationConsent
} from "./service";
import { DelegatedDeliveryStoreError, type DelegationRequestRecord } from "./types";
import { canonicalJson, sha256Hex } from "./validation";

const now = new Date("2026-08-22T00:00:00.000Z");
const callbackUri = "https://playtest.example/api/announcements/delegation/callback";
const issuer = "https://prism.example";
const cipher = createLocalAesGcmCredentialCipher({
  key: Buffer.alloc(32, 7).toString("base64"),
  keyId: "delegation-test-key"
});

async function proofFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = await exportJWK(publicKey) as DelegatedDeliveryPublicJwk;
  publicJwk.alg = "ES256";
  publicJwk.kid = "playtest-delegation-key-v1";
  const config: Extract<DelegatedDeliveryConfig, { enabled: true }> = {
    enabled: true,
    issuer,
    clientId: "shg-playtest-delegation",
    callbackUri,
    clientJwks: [publicJwk],
    grantPepper: "grant-pepper-secret-canary-32-bytes-minimum",
    grantPepperId: "grant-pepper-v1",
    allowInsecureHttp: false,
    trustProxyHeaders: false,
    limits: {
      approvalTtlMs: 600_000,
      authorizationCodeTtlMs: 300_000,
      maxScheduleHorizonMs: 30 * 24 * 60 * 60_000,
      grantTtlMs: 30 * 60_000,
      statusRetentionMs: 30 * 24 * 60 * 60_000,
      proofClockSkewSeconds: 60,
      proofLifetimeSeconds: 60,
      rateWindowMs: 60_000,
      maxRequestsPerSource: 30,
      maxRequestsPerClient: 300,
      maxRequestsPerUser: 30,
      maxRequestsPerChannel: 60,
      maxOutstandingPendingPerSource: 10,
      maxOutstandingPendingPerClient: 500,
      maxOutstandingPendingPerUser: 20,
      cleanupBatchSize: 100
    }
  };
  return { privateKey, publicJwk, config };
}

function requestBody(payloadText = "MESSAGE_CONTENT_SECRET_CANARY") {
  const payload = { channel: "C123ABC", text: payloadText, blocks: [{ type: "section", text: { type: "plain_text", text: payloadText } }] };
  return JSON.stringify({
    client_id: "shg-playtest-delegation",
    callback_uri: callbackUri,
    external_job_id: "job-123",
    revision: 1,
    idempotency_key: "job-123:1",
    expected_subject: "prism-user-123",
    team_id: "T123ABC",
    channel_id: "C123ABC",
    action: "chat.postMessage",
    execution_mode: "user",
    payload,
    payload_sha256: sha256Hex(canonicalJson(payload)),
    not_before: "2026-08-22T00:05:00.000Z",
    delivery_expires_at: "2026-08-22T00:35:00.000Z",
    state: "s".repeat(43),
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    dpop_jkt: "j".repeat(43)
  });
}

async function clientProof(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], body: string) {
  return new SignJWT({
    iss: "shg-playtest-delegation",
    sub: "shg-playtest-delegation",
    aud: "urn:prism:delegated-slack-message:v1",
    htu: `${issuer}/v1/prism/delegations/slack-message/requests`,
    htm: "POST",
    body_sha256: sha256Hex(body),
    iat: 1_787_356_800,
    exp: 1_787_356_860,
    jti: "client-proof-jti-create-1"
  }).setProtectedHeader({ typ: "prism-client-proof+jwt", alg: "ES256", kid: "playtest-delegation-key-v1" }).sign(privateKey);
}

describe("delegated delivery issuance service", () => {
  it("rejects the disabled feature before parsing, encryption, or persistence", async () => {
    const delegatedStore = fakeStore();
    const disabledCipher = { encrypt: vi.fn(), decrypt: vi.fn() };
    await expect(createDelegationRequest({
      rawBody: "not-json",
      clientProof: null,
      sourceIdentifier: "192.0.2.1",
      store: delegatedStore,
      cipher: disabledCipher,
      config: { enabled: false }
    })).resolves.toEqual({ kind: "error", status: 404, error: "feature_disabled" });
    expect(disabledCipher.encrypt).not.toHaveBeenCalled();
    expect(delegatedStore.createRequest).not.toHaveBeenCalled();
  });

  it("encrypts payload/state/handle custody and returns only the safe approval locator", async () => {
    const { privateKey, config } = await proofFixture();
    const body = requestBody();
    let persisted: Parameters<DelegatedDeliveryStore["createRequest"]>[0] | undefined;
    const delegatedStore = fakeStore({
      createRequest: vi.fn(async (input) => {
        persisted = input;
        return {
          kind: "created" as const,
          approvalHandleEnvelope: input.approvalHandleEnvelope,
          request: {
            id: input.requestId,
            clientId: input.request.clientId,
            externalJobId: input.request.externalJobId,
            revision: input.request.revision,
            idempotencyKey: input.request.idempotencyKey,
            callbackUri: input.request.callbackUri,
            expectedPrismUserId: input.request.expectedPrismUserId,
            action: "chat.postMessage" as const,
            executionMode: "user" as const,
            teamId: input.request.teamId,
            channelId: input.request.channelId,
            payloadEnvelope: input.payloadEnvelope,
            payloadSha256: input.request.payloadSha256,
            returnStateEnvelope: input.returnStateEnvelope,
            codeChallenge: input.request.codeChallenge,
            dpopJkt: input.request.dpopJkt,
            notBefore: input.request.notBefore,
            approvalExpiresAt: input.approvalExpiresAt,
            deliveryExpiresAt: input.request.deliveryExpiresAt,
            state: "pending" as const
          }
        };
      })
    });

    const result = await createDelegationRequest({
      rawBody: body,
      clientProof: await clientProof(privateKey, body),
      sourceIdentifier: "192.0.2.1",
      store: delegatedStore,
      cipher,
      config,
      now,
      random: () => Buffer.alloc(32, 5),
      randomId: () => "ddr_1234567890123456"
    });

    expect(result).toEqual({
      kind: "success",
      status: 201,
      body: {
        request_id: "ddr_1234567890123456",
        approval_url: expect.stringMatching(/^https:\/\/prism\.example\/delegations\/slack-message\/authorize\?request=/),
        approval_expires_at: "2026-08-22T00:10:00.000Z"
      }
    });
    expect(JSON.stringify(persisted?.payloadEnvelope)).not.toContain("MESSAGE_CONTENT_SECRET_CANARY");
    expect(JSON.stringify(persisted?.returnStateEnvelope)).not.toContain("s".repeat(43));
    expect(JSON.stringify(persisted?.approvalHandleEnvelope)).not.toContain(Buffer.alloc(32, 5).toString("base64url"));
    expect(JSON.stringify(result)).not.toContain("MESSAGE_CONTENT_SECRET_CANARY");
  });

  it("continues an unauthenticated approval through typed Slack OAuth without auto-approval", async () => {
    const { config } = await proofFixture();
    const delegatedStore = fakeStore({
      loadConsent: vi.fn(async () => ({
        kind: "login_required" as const,
        requestId: "ddr_12345678-1234-4123-8123-123456789012"
      }))
    });

    await expect(resolveDelegationConsent({
      handle: "h".repeat(43),
      store: delegatedStore,
      cipher,
      config,
      now
    })).resolves.toEqual({
      kind: "redirect",
      location: "https://prism.example/v1/slack/oauth/start?delegation_request=ddr_12345678-1234-4123-8123-123456789012"
    });
    expect(delegatedStore.approveRequest).not.toHaveBeenCalled();
  });

  it("decrypts and hash-verifies the exact payload for an eligible existing Prism session", async () => {
    const { config } = await proofFixture();
    const payload = { channel: "C123ABC", text: "EXACT_CONSENT_MESSAGE_CANARY", blocks: [] };
    const plaintext = canonicalJson(payload);
    const stateEnvelope = await cipher.encrypt("s".repeat(43), "playtest-delivery:ddr_1234567890123456:state");
    const payloadEnvelope = await cipher.encrypt(plaintext, "playtest-delivery:ddr_1234567890123456:payload");
    const record = requestRecord({ stateEnvelope, payloadEnvelope });
    record.payloadSha256 = sha256Hex(plaintext);
    const delegatedStore = fakeStore({
      loadConsent: vi.fn(async () => ({
        kind: "ready" as const,
        request: record,
        identity: {
          prismUserId: "prism-user-123",
          slackConnectionId: "connection-1",
          slackUserId: "U0123456789",
          slackUserDisplayName: "Ada",
          teamId: "T123ABC",
          teamName: "Studio"
        }
      }))
    });

    const result = await resolveDelegationConsent({
      handle: "h".repeat(43),
      sessionToken: "session-token",
      store: delegatedStore,
      cipher,
      config,
      now
    });

    expect(result).toMatchObject({
      kind: "preview",
      preview: {
        payload,
        payloadSha256: sha256Hex(plaintext),
        identity: { prismUserId: "prism-user-123", slackUserId: "U0123456789" }
      }
    });
  });

  it("allows one approval under concurrency and stores only a code hash", async () => {
    const { config } = await proofFixture();
    const stateEnvelope = await cipher.encrypt("s".repeat(43), "playtest-delivery:ddr_1234567890123456:state");
    const payloadEnvelope = await cipher.encrypt(canonicalJson({ channel: "C123ABC", text: "hello", blocks: [] }), "playtest-delivery:ddr_1234567890123456:payload");
    const record = requestRecord({ stateEnvelope, payloadEnvelope });
    let approvalCount = 0;
    let persistedCodeHash = "";
    const delegatedStore = fakeStore({
      approveRequest: vi.fn(async (input) => {
        if (approvalCount++ > 0) throw new DelegatedDeliveryStoreError("lifecycle_conflict");
        persistedCodeHash = input.codeHash;
        return {
          request: { ...record, state: "approved" as const },
          identity: {
            prismUserId: "prism-user-123", slackConnectionId: "connection-1", slackUserId: "U123",
            slackUserDisplayName: "Ada", teamId: "T123ABC", teamName: "Studio"
          }
        };
      })
    });

    const results = await Promise.all([
      approveDelegationRequest({ requestId: record.id, sessionToken: "session", store: delegatedStore, cipher, config, now, random: () => Buffer.alloc(32, 8) }),
      approveDelegationRequest({ requestId: record.id, sessionToken: "session", store: delegatedStore, cipher, config, now, random: () => Buffer.alloc(32, 9) })
    ]);
    expect(results.filter((result) => result.kind === "redirect")).toHaveLength(1);
    expect(results).toContainEqual({ kind: "error", status: 409, error: "lifecycle_conflict" });
    expect(persistedCodeHash).toMatch(/^[a-f0-9]{64}$/);
    const redirect = results.find((result) => result.kind === "redirect");
    if (!redirect || redirect.kind !== "redirect") throw new Error("missing redirect");
    const rawCode = new URL(redirect.location).searchParams.get("code");
    expect(rawCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(persistedCodeHash).not.toBe(rawCode);
  });

  it("exchanges PKCE + DPoP once, exposing the opaque grant only in the token response", async () => {
    const { config } = await proofFixture();
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicJwk = await exportJWK(publicKey);
    const thumbprintJwk = { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y };
    const jkt = await calculateJwkThumbprint(thumbprintJwk, "sha256");
    const dpop = await new SignJWT({
      htu: `${issuer}/v1/prism/delegations/slack-message/token`, htm: "POST",
      iat: 1_787_356_800, jti: "dpop-exchange-jti-1"
    }).setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: thumbprintJwk }).sign(privateKey);
    let persistedGrant: Parameters<DelegatedDeliveryStore["exchangeCodeForGrant"]>[0] | undefined;
    const delegatedStore = fakeStore({
      loadCodeBinding: vi.fn(async () => ({ kind: "ready" as const, dpopJkt: jkt })),
      exchangeCodeForGrant: vi.fn(async (input) => {
        persistedGrant = input;
        return {
          grantId: input.grantId,
          clientId: "shg-playtest-delegation",
          externalJobId: "job-123",
          revision: 1,
          prismUserId: "prism-user-123",
          slackUserId: "U123",
          teamId: "T123ABC",
          channelId: "C123ABC",
          payloadSha256: "a".repeat(64),
          notBefore: new Date("2026-08-22T00:05:00.000Z"),
          expiresAt: new Date("2026-08-22T00:35:00.000Z")
        };
      })
    });
    const params = new URLSearchParams({
      grant_type: "urn:prism:params:grant-type:delegated-slack-message",
      client_id: "shg-playtest-delegation",
      redirect_uri: callbackUri,
      code: "a".repeat(43),
      code_verifier: "v".repeat(43)
    });
    const result = await exchangeDelegatedAuthorizationCode({
      params, dpopProof: dpop, store: delegatedStore, config, now,
      random: () => Buffer.alloc(32, 11), randomId: () => "ddg_1234567890123456"
    });
    expect(result).toMatchObject({
      kind: "success",
      body: {
        grant_token: expect.stringMatching(/^prism_grant_[A-Za-z0-9_-]{43}$/),
        token_type: "DPoP",
        expires_in: 2100,
        grant_id: "ddg_1234567890123456",
        client_id: "shg-playtest-delegation",
        external_job_id: "job-123",
        revision: 1,
        prism_user_id: "prism-user-123",
        slack_user_id: "U123",
        team_id: "T123ABC",
        channel_id: "C123ABC",
        payload_sha256: "a".repeat(64),
        not_before: "2026-08-22T00:05:00.000Z",
        expires_at: "2026-08-22T00:35:00.000Z"
      }
    });
    if (result.kind !== "success") throw new Error("expected success");
    expect(persistedGrant?.grantHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persistedGrant)).not.toContain(result.body.grant_token);
    expect(JSON.stringify(persistedGrant)).not.toContain(config.grantPepper);
  });

  it("returns 410 for an expired or already-consumed authorization code before grant work", async () => {
    const { config } = await proofFixture();
    const delegatedStore = fakeStore({
      loadCodeBinding: vi.fn(async () => ({ kind: "expired" as const }))
    });
    const params = new URLSearchParams({
      grant_type: "urn:prism:params:grant-type:delegated-slack-message",
      client_id: "shg-playtest-delegation",
      redirect_uri: callbackUri,
      code: "a".repeat(43),
      code_verifier: "v".repeat(43)
    });

    await expect(exchangeDelegatedAuthorizationCode({
      params,
      dpopProof: "not-needed-for-dead-code",
      store: delegatedStore,
      config,
      now
    })).resolves.toEqual({ kind: "error", status: 410, error: "invalid_grant" });
    expect(delegatedStore.exchangeCodeForGrant).not.toHaveBeenCalled();
  });
});

function requestRecord(input: {
  stateEnvelope: Awaited<ReturnType<typeof cipher.encrypt>>;
  payloadEnvelope: Awaited<ReturnType<typeof cipher.encrypt>>;
}): DelegationRequestRecord {
  return {
    id: "ddr_1234567890123456",
    clientId: "shg-playtest-delegation",
    externalJobId: "job-123",
    revision: 1,
    idempotencyKey: "job-123:1",
    callbackUri,
    expectedPrismUserId: "prism-user-123",
    action: "chat.postMessage",
    executionMode: "user",
    teamId: "T123ABC",
    channelId: "C123ABC",
    payloadEnvelope: input.payloadEnvelope,
    payloadSha256: sha256Hex(canonicalJson({ channel: "C123ABC", text: "hello", blocks: [] })),
    returnStateEnvelope: input.stateEnvelope,
    codeChallenge: "c".repeat(43),
    dpopJkt: "j".repeat(43),
    notBefore: new Date("2026-08-22T00:05:00.000Z"),
    approvalExpiresAt: new Date("2026-08-22T00:10:00.000Z"),
    deliveryExpiresAt: new Date("2026-08-22T00:35:00.000Z"),
    state: "pending"
  };
}

function fakeStore(overrides: Partial<DelegatedDeliveryStore> = {}): DelegatedDeliveryStore {
  return {
    createRequest: vi.fn(async () => { throw new Error("unexpected-create"); }),
    loadConsent: vi.fn(async () => ({ kind: "not_found" as const })),
    saveOAuthResumeHandle: vi.fn(async () => false),
    approveRequest: vi.fn(async () => null),
    denyRequest: vi.fn(async () => null),
    denyRequestAfterOAuth: vi.fn(async () => null),
    loadCodeBinding: vi.fn(async () => null),
    exchangeCodeForGrant: vi.fn(async () => null),
    ...overrides
  };
}
