import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  sha256Hex,
  validateDelegatedTokenForm,
  validateDelegationRequestJson
} from "./validation";

const now = new Date("2026-08-22T00:00:00.000Z");
const options = {
  clientId: "shg-playtest-delegation",
  callbackUri: "https://playtest.example/api/announcements/delegation/callback",
  approvalTtlMs: 10 * 60 * 1000,
  maxScheduleHorizonMs: 30 * 24 * 60 * 60 * 1000,
  maxGrantWindowMs: 30 * 60 * 1000
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = { channel: "C123ABC", text: "Fallback text", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Hello" } }] };
  return {
    client_id: options.clientId,
    callback_uri: options.callbackUri,
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
    dpop_jkt: "j".repeat(43),
    ...overrides
  };
}

describe("delegated Slack message wire validation", () => {
  it("canonicalizes and accepts only the exact registered immutable request", () => {
    const result = validateDelegationRequestJson({ rawBody: JSON.stringify(request()), options, now });
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") throw new Error("expected valid request");
    expect(result.request).toMatchObject({
      clientId: options.clientId,
      callbackUri: options.callbackUri,
      action: "chat.postMessage",
      executionMode: "user",
      payloadSha256: request().payload_sha256,
      immutableDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it.each([
    ["unknown field", { sender: "UATTACKER" }],
    ["callback prefix", { callback_uri: `${options.callbackUri}/extra` }],
    ["caller-selected method", { action: "chat.delete" }],
    ["bot fallback", { execution_mode: "bot" }],
    ["channel name", { channel_id: "general" }],
    ["workspace mismatch", { team_id: "not-a-team" }],
    ["hash mismatch", { payload_sha256: "0".repeat(64) }],
    ["plain PKCE", { code_challenge_method: "plain" }],
    ["delivery ends before approval can complete", { not_before: "2026-08-22T00:00:00.000Z", delivery_expires_at: "2026-08-22T00:09:59.000Z" }],
    ["schedule too far", { not_before: "2026-09-22T00:00:01.000Z", delivery_expires_at: "2026-09-22T00:30:01.000Z" }],
    ["grant too long", { delivery_expires_at: "2026-08-22T00:35:00.001Z" }]
  ])("rejects %s", (_label, override) => {
    expect(validateDelegationRequestJson({ rawBody: JSON.stringify(request(override)), options, now })).toEqual({ kind: "invalid" });
  });

  it("rejects payload channel divergence, payload unknown fields, and duplicate JSON keys", () => {
    const mismatched = request({ payload: { channel: "COTHER", text: "hello", blocks: [] } });
    mismatched.payload_sha256 = sha256Hex(canonicalJson(mismatched.payload));
    expect(validateDelegationRequestJson({ rawBody: JSON.stringify(mismatched), options, now }).kind).toBe("invalid");

    const extraPayload = request({ payload: { channel: "C123ABC", text: "hello", blocks: [], username: "forged" } });
    extraPayload.payload_sha256 = sha256Hex(canonicalJson(extraPayload.payload));
    expect(validateDelegationRequestJson({ rawBody: JSON.stringify(extraPayload), options, now }).kind).toBe("invalid");

    const raw = JSON.stringify(request()).replace('"revision":1', '"revision":1,"revision":2');
    expect(validateDelegationRequestJson({ rawBody: raw, options, now }).kind).toBe("invalid");
  });

  it("fails deeply nested JSON closed as invalid instead of throwing", () => {
    const deeplyNested = `${"[".repeat(20_000)}0${"]".repeat(20_000)}`;
    expect(() => validateDelegationRequestJson({ rawBody: deeplyNested, options, now })).not.toThrow();
    expect(validateDelegationRequestJson({ rawBody: deeplyNested, options, now })).toEqual({ kind: "invalid" });
  });

  it("requires exact, single form fields for grant exchange", () => {
    const valid = new URLSearchParams({
      grant_type: "urn:prism:params:grant-type:delegated-slack-message",
      client_id: options.clientId,
      redirect_uri: options.callbackUri,
      code: "a".repeat(43),
      code_verifier: "v".repeat(43)
    });
    expect(validateDelegatedTokenForm(valid, options)).toMatchObject({ kind: "valid" });

    valid.append("code", "b".repeat(43));
    expect(validateDelegatedTokenForm(valid, options)).toEqual({ kind: "invalid" });

    const unknown = new URLSearchParams({
      grant_type: "urn:prism:params:grant-type:delegated-slack-message",
      client_id: options.clientId,
      redirect_uri: options.callbackUri,
      code: "a".repeat(43),
      code_verifier: "v".repeat(43),
      actorSubject: "attacker"
    });
    expect(validateDelegatedTokenForm(unknown, options)).toEqual({ kind: "invalid" });
  });
});
