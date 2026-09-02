import "server-only";

import { randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";

import { hashSecret } from "../slack/oauth-flow";
import { hashDeveloperToken, issueDeveloperToken, type DeveloperTokenConfig } from "../token-profiles/developer-token";
import type { BeginLocalAppAuthorizationInput, LocalAppAuthorizationStore } from "./types";
import { canonicalUserCode } from "./validation";

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LOCAL_APP_AUTHORIZATION_TTL_MS = 10 * 60_000;
export const LOCAL_APP_POLL_INTERVAL_SECONDS = 5;
export function localAppUserCodeCookieName(requestId: string): string {
  return `prism_local_app_user_code_${requestId}`;
}

export async function beginLocalAppAuthorization(input: {
  store: LocalAppAuthorizationStore;
  request: BeginLocalAppAuthorizationInput;
  publicBaseUrl: string;
  sourceIdentifier?: string;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
  randomId?: () => string;
}) {
  const now = input.now ?? new Date();
  const randomBytes = input.randomBytes ?? nodeRandomBytes;
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = createUserCode(randomBytes(8));
  const requestId = input.randomId?.() ?? randomUUID();
  const expiresAt = new Date(now.getTime() + LOCAL_APP_AUTHORIZATION_TTL_MS);
  const result = await input.store.begin({
    requestId,
    deviceCodeHash: hashSecret(deviceCode),
    userCodeHash: hashSecret(userCode),
    clientId: input.request.clientId,
    displayName: input.request.displayName,
    intendedUse: input.request.intendedUse,
    inboundBlockActions: input.request.inbound?.blockActions === true,
    sourceKey: sourceKey(input.sourceIdentifier),
    pollIntervalSeconds: LOCAL_APP_POLL_INTERVAL_SECONDS,
    expiresAt,
    now
  });
  if (result !== "created") return { kind: "rate_limited" as const };

  const verification = new URL("/local-app/authorize", input.publicBaseUrl);
  verification.searchParams.set("user_code", userCode);
  return {
    kind: "created" as const,
    deviceCode,
    userCode,
    verificationUri: new URL("/local-app/authorize", input.publicBaseUrl).toString(),
    verificationUriComplete: verification.toString(),
    expiresAt,
    intervalSeconds: LOCAL_APP_POLL_INTERVAL_SECONDS
  };
}

export async function resolveLocalAppConsent(input: {
  store: LocalAppAuthorizationStore;
  userCode?: string;
  requestId?: string;
  sessionToken?: string;
  sourceIdentifier?: string;
  now?: Date;
}) {
  const userCode = input.userCode === undefined ? null : canonicalUserCode(input.userCode);
  const requestId = input.requestId && validRequestId(input.requestId) ? input.requestId : null;
  if ((input.userCode !== undefined && !userCode) || (!userCode && !requestId)) {
    return { kind: "unavailable" as const };
  }
  const allowed = await input.store.consumeRequestRateLimit({
    action: "consent",
    sourceKey: sourceKey(input.sourceIdentifier),
    now: input.now ?? new Date()
  });
  if (!allowed) return { kind: "rate_limited" as const };
  const result = await input.store.resolveConsent({
    userCodeHash: userCode ? hashSecret(userCode) : null,
    requestId,
    sessionTokenHash: input.sessionToken ? hashSecret(input.sessionToken) : null,
    now: input.now ?? new Date()
  });
  return result.kind === "preview"
    ? { kind: "preview" as const, preview: { ...result.preview, userCode } }
    : result;
}

export async function decideLocalAppAuthorization(input: {
  store: LocalAppAuthorizationStore;
  requestId: string;
  sessionToken?: string;
  decision: "approve" | "deny";
  auditRequestId: string;
  now?: Date;
}) {
  if (!validRequestId(input.requestId) || !input.sessionToken) return "unavailable" as const;
  return input.store.decide({
    requestId: input.requestId,
    sessionTokenHash: hashSecret(input.sessionToken),
    decision: input.decision,
    now: input.now ?? new Date(),
    auditRequestId: input.auditRequestId
  });
}

export async function denyLocalAppAuthorizationAfterOAuth(input: {
  store: LocalAppAuthorizationStore;
  requestId: string;
  now?: Date;
}) {
  if (!validRequestId(input.requestId)) return;
  await input.store.denyAfterOAuth({
    requestId: input.requestId,
    now: input.now ?? new Date()
  });
}

export async function pollLocalAppAuthorization(input: {
  store: LocalAppAuthorizationStore;
  clientId: string;
  deviceCode: string;
  developerTokenConfig: DeveloperTokenConfig;
  auditRequestId: string;
  sourceIdentifier?: string;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}) {
  const now = input.now ?? new Date();
  const allowed = await input.store.consumeRequestRateLimit({
    action: "poll",
    sourceKey: sourceKey(input.sourceIdentifier),
    now
  });
  if (!allowed) return { kind: "rate_limited" as const, retryAfterSeconds: 60 };
  return input.store.exchange({
    deviceCodeHash: hashSecret(input.deviceCode),
    clientId: input.clientId,
    now,
    issueCredential() {
      const developerToken = issueDeveloperToken({ randomBytes: input.randomBytes });
      return {
        developerToken,
        verifier: hashDeveloperToken(developerToken, input.developerTokenConfig)
      };
    },
    auditRequestId: input.auditRequestId
  });
}

function sourceKey(sourceIdentifier?: string): string {
  return hashSecret(`local-app-source:${sourceIdentifier ?? "unattributed"}`);
}

function createUserCode(bytes: Buffer): string {
  const characters = Array.from(bytes.subarray(0, 8), (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4, 8).join("")}`;
}

function validRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
