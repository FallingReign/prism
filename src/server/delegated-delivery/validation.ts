import "server-only";

import { createHash } from "node:crypto";

import {
  DELEGATED_ACTION,
  DELEGATED_EXECUTION_MODE,
  DELEGATED_GRANT_TYPE,
  type DelegatedSlackPayload,
  type DelegationRequestInput
} from "./types";

const REQUEST_FIELDS = [
  "client_id",
  "callback_uri",
  "external_job_id",
  "revision",
  "idempotency_key",
  "expected_subject",
  "team_id",
  "channel_id",
  "action",
  "execution_mode",
  "payload",
  "payload_sha256",
  "not_before",
  "delivery_expires_at",
  "state",
  "code_challenge",
  "code_challenge_method",
  "dpop_jkt"
] as const;

const TOKEN_FIELDS = ["grant_type", "client_id", "redirect_uri", "code", "code_verifier"] as const;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_TEXT_LENGTH = 40_000;
const MAX_BLOCKS = 50;

export type DelegationValidationOptions = {
  clientId: string;
  callbackUri: string;
  approvalTtlMs: number;
  maxScheduleHorizonMs: number;
  maxGrantWindowMs: number;
};

export type ValidatedDelegatedTokenRequest = {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
};

export function validateDelegationRequestJson(input: {
  rawBody: string;
  options: DelegationValidationOptions;
  now?: Date;
}): { kind: "valid"; request: DelegationRequestInput } | { kind: "invalid" } {
  if (!input.rawBody) return { kind: "invalid" };
  try {
    if (hasDuplicateJsonObjectKeys(input.rawBody)) return { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { kind: "invalid" };
  }
  if (!isExactObject(parsed, REQUEST_FIELDS)) return { kind: "invalid" };

  const payload = validatePayload(parsed.payload, parsed.channel_id);
  if (!payload) return { kind: "invalid" };
  const canonicalPayload = canonicalJson(payload);
  if (Buffer.byteLength(canonicalPayload, "utf8") > MAX_PAYLOAD_BYTES) return { kind: "invalid" };
  const payloadSha256 = sha256Hex(canonicalPayload);

  const now = input.now ?? new Date();
  const notBefore = parseUtcInstant(parsed.not_before);
  const deliveryExpiresAt = parseUtcInstant(parsed.delivery_expires_at);
  if (
    parsed.client_id !== input.options.clientId ||
    parsed.callback_uri !== input.options.callbackUri ||
    !boundedIdentifier(parsed.external_job_id, 1, 160) ||
    typeof parsed.revision !== "number" ||
    !Number.isSafeInteger(parsed.revision) ||
    parsed.revision < 1 ||
    parsed.revision > 1_000_000 ||
    !boundedIdentifier(parsed.idempotency_key, 1, 200) ||
    !boundedOpaque(parsed.expected_subject, 1, 160) ||
    !isSlackTeamId(parsed.team_id) ||
    !isSlackChannelId(parsed.channel_id) ||
    parsed.action !== DELEGATED_ACTION ||
    parsed.execution_mode !== DELEGATED_EXECUTION_MODE ||
    parsed.payload_sha256 !== payloadSha256 ||
    !notBefore ||
    !deliveryExpiresAt ||
    notBefore.getTime() < now.getTime() - 5 * 60_000 ||
    notBefore.getTime() > now.getTime() + input.options.maxScheduleHorizonMs ||
    deliveryExpiresAt.getTime() <= Math.max(
      now.getTime() + input.options.approvalTtlMs,
      notBefore.getTime()
    ) ||
    deliveryExpiresAt.getTime() - notBefore.getTime() > input.options.maxGrantWindowMs ||
    !isOpaque256(parsed.state) ||
    !isS256Value(parsed.code_challenge) ||
    parsed.code_challenge_method !== "S256" ||
    !isS256Value(parsed.dpop_jkt)
  ) {
    return { kind: "invalid" };
  }

  const normalized = {
    client_id: parsed.client_id,
    callback_uri: parsed.callback_uri,
    external_job_id: parsed.external_job_id,
    revision: parsed.revision,
    idempotency_key: parsed.idempotency_key,
    expected_subject: parsed.expected_subject,
    team_id: parsed.team_id,
    channel_id: parsed.channel_id,
    action: DELEGATED_ACTION,
    execution_mode: DELEGATED_EXECUTION_MODE,
    payload,
    payload_sha256: payloadSha256,
    not_before: notBefore.toISOString(),
    delivery_expires_at: deliveryExpiresAt.toISOString(),
    state: parsed.state,
    code_challenge: parsed.code_challenge,
    code_challenge_method: "S256",
    dpop_jkt: parsed.dpop_jkt
  };

  return {
    kind: "valid",
    request: {
      clientId: parsed.client_id,
      callbackUri: parsed.callback_uri,
      externalJobId: parsed.external_job_id,
      revision: parsed.revision,
      idempotencyKey: parsed.idempotency_key,
      expectedPrismUserId: parsed.expected_subject,
      teamId: parsed.team_id,
      channelId: parsed.channel_id,
      action: DELEGATED_ACTION,
      executionMode: DELEGATED_EXECUTION_MODE,
      payload,
      canonicalPayload,
      payloadSha256,
      notBefore,
      deliveryExpiresAt,
      returnState: parsed.state,
      codeChallenge: parsed.code_challenge,
      codeChallengeMethod: "S256",
      dpopJkt: parsed.dpop_jkt,
      immutableDigest: sha256Hex(canonicalJson(normalized))
    }
  };
}

export function validateDelegatedTokenForm(
  params: URLSearchParams,
  options: Pick<DelegationValidationOptions, "clientId" | "callbackUri">
): { kind: "valid"; request: ValidatedDelegatedTokenRequest } | { kind: "invalid" } {
  const values = uniqueParameters(params, TOKEN_FIELDS);
  if (
    !values ||
    values.grant_type !== DELEGATED_GRANT_TYPE ||
    values.client_id !== options.clientId ||
    values.redirect_uri !== options.callbackUri ||
    !isOpaque256(values.code) ||
    !isValidCodeVerifier(values.code_verifier)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    request: {
      clientId: values.client_id,
      redirectUri: values.redirect_uri,
      code: values.code,
      codeVerifier: values.code_verifier
    }
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("non-canonical-json-value");
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Base64Url(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function isValidCodeVerifier(value: string): boolean {
  return value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(value);
}

function validatePayload(value: unknown, expectedChannel: unknown): DelegatedSlackPayload | null {
  if (!isExactObject(value, ["channel", "text", "blocks"] as const)) return null;
  if (
    value.channel !== expectedChannel ||
    !isSlackChannelId(value.channel) ||
    typeof value.text !== "string" ||
    value.text.length < 1 ||
    value.text.length > MAX_TEXT_LENGTH ||
    /[\u0000]/.test(value.text) ||
    !Array.isArray(value.blocks) ||
    value.blocks.length > MAX_BLOCKS ||
    !value.blocks.every((block) => isPlainObject(block) && boundedJsonTree(block, 0))
  ) {
    return null;
  }
  return { channel: value.channel, text: value.text, blocks: value.blocks };
}

function boundedJsonTree(value: unknown, depth: number): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= MAX_TEXT_LENGTH && !/[\u0000]/.test(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => boundedJsonTree(item, depth + 1));
  if (!isPlainObject(value) || Object.keys(value).length > 100) return false;
  return Object.entries(value).every(([key, item]) => key.length <= 200 && boundedJsonTree(item, depth + 1));
}

function isExactObject<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys
): value is Record<Keys[number], unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => (keys as readonly string[]).includes(key));
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function uniqueParameters<const Names extends readonly string[]>(
  params: URLSearchParams,
  names: Names
): { [Name in Names[number]]: string } | null {
  const allowed = new Set<string>(names);
  for (const name of params.keys()) if (!allowed.has(name)) return null;
  const values = {} as { [Name in Names[number]]: string };
  for (const name of names) {
    const matches = params.getAll(name);
    if (matches.length !== 1) return null;
    values[name as Names[number]] = matches[0]!;
  }
  return values;
}

function parseUtcInstant(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed : null;
}

function boundedIdentifier(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(value);
}

function boundedOpaque(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSlackTeamId(value: unknown): value is string {
  return typeof value === "string" && /^T[A-Z0-9]{2,}$/.test(value) && value.length <= 32;
}

function isSlackChannelId(value: unknown): value is string {
  return typeof value === "string" && /^[CG][A-Z0-9]{2,}$/.test(value) && value.length <= 32;
}

function isOpaque256(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isS256Value(value: unknown): value is string {
  return isOpaque256(value);
}

/** Reject duplicate keys before JSON.parse can silently apply last-key wins. */
function hasDuplicateJsonObjectKeys(raw: string): boolean {
  let index = 0;
  const skipWhitespace = () => { while (/\s/.test(raw[index] ?? "")) index += 1; };
  const stringToken = (): string | null => {
    if (raw[index] !== '"') return null;
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === "\\") { index += 2; continue; }
      if (raw[index] === '"') {
        index += 1;
        try { return JSON.parse(raw.slice(start, index)); } catch { return null; }
      }
      index += 1;
    }
    return null;
  };
  const value = (): boolean => {
    skipWhitespace();
    if (raw[index] === "{") {
      index += 1;
      const seen = new Set<string>();
      skipWhitespace();
      if (raw[index] === "}") { index += 1; return false; }
      while (index < raw.length) {
        skipWhitespace();
        const key = stringToken();
        if (key === null || seen.has(key)) return true;
        seen.add(key);
        skipWhitespace();
        if (raw[index++] !== ":" || value()) return true;
        skipWhitespace();
        if (raw[index] === "}") { index += 1; return false; }
        if (raw[index++] !== ",") return true;
      }
      return true;
    }
    if (raw[index] === "[") {
      index += 1;
      skipWhitespace();
      if (raw[index] === "]") { index += 1; return false; }
      while (index < raw.length) {
        if (value()) return true;
        skipWhitespace();
        if (raw[index] === "]") { index += 1; return false; }
        if (raw[index++] !== ",") return true;
      }
      return true;
    }
    if (raw[index] === '"') return stringToken() === null;
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(index));
    if (!match) return true;
    index += match[0].length;
    return false;
  };
  const invalidOrDuplicate = value();
  skipWhitespace();
  return invalidOrDuplicate || index !== raw.length;
}
