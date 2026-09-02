import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOriginBrowserMutation } from "../../../../../src/server/http/browser-mutation-csrf";
import { getSlackOAuthDeploymentConfig } from "../../../../../src/server/config";
import {
  clearSetupBrowserTransaction,
  hasSafeSetupNavigationMetadata,
  rejectUnprovenSetupBrowserMutation,
  type SetupBrowserMutationProof
} from "../../../../../src/server/setup/browser-transaction-http";
import { isFormUrlEncodedContentType, readBoundedText, setupSessionCookieName, secure } from "../session/handler";

const MAX_BODY_BYTES = 16 * 1024;

type SetupContext = { id: string; pendingConfigurationVersionId: string | null };
type RedactedPending = {
  clientId: string;
  version: string;
  botScopes: string[];
  userScopes: string[];
  socketModeEnabled: boolean;
  socketApiAppId: string | null;
  socketAppTokenConfigured: boolean;
};

export type SlackConfigurationRouteDependencies = SetupBrowserMutationProof & {
  resolveSession(token: string): Promise<SetupContext | null>;
  createPendingConfiguration(input: {
    setupSessionId: string;
    expectedPendingVersionId: string | null;
    clientId: unknown;
    clientSecret: unknown;
    botScopes: unknown;
    userScopes: unknown;
    socketModeEnabled: unknown;
    socketApiAppId: unknown;
    socketAppToken: unknown;
    requestId: string;
  }): Promise<RedactedPending>;
};

export async function handleSlackConfigurationPut(request: NextRequest, dependencies: SlackConfigurationRouteDependencies): Promise<NextResponse> {
  if (request.nextUrl.search) return json({ error: "invalid_request" }, 400);
  const csrf = rejectCrossOriginBrowserMutation(request);
  if (csrf) return secure(csrf);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return json({ error: "request_too_large" }, 413);

  const setupToken = request.cookies.get(setupSessionCookieName)?.value;
  if (!setupToken) return json({ error: "session_expired" }, 401);
  const session = await dependencies.resolveSession(setupToken);
  if (!session) return json({ error: "session_expired" }, 401);

  const raw = await readBoundedText(request, MAX_BODY_BYTES);
  if (raw === null) return json({ error: "request_too_large" }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "invalid_configuration" }, 400);
    body = parsed as Record<string, unknown>;
    const allowedKeys = new Set(["clientId", "clientSecret", "botScopes", "userScopes", "socketModeEnabled", "socketApiAppId", "socketAppToken", "socketCallbacksReviewed"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) return json({ error: "invalid_configuration" }, 400);
    if (body.socketModeEnabled === true && body.socketCallbacksReviewed !== true) return json({ error: "invalid_configuration" }, 400);
  } catch {
    return json({ error: "invalid_configuration" }, 400);
  }

  try {
    const pending = await dependencies.createPendingConfiguration({
      setupSessionId: session.id,
      expectedPendingVersionId: session.pendingConfigurationVersionId,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      botScopes: body.botScopes,
      userScopes: body.userScopes,
      socketModeEnabled: body.socketModeEnabled,
      socketApiAppId: body.socketApiAppId,
      socketAppToken: body.socketAppToken,
      requestId: randomUUID()
    });
    return json({ configuration: {
      clientId: pending.clientId,
      version: pending.version,
      secretStored: true,
      botScopes: pending.botScopes,
      userScopes: pending.userScopes,
      socketModeEnabled: pending.socketModeEnabled,
      socketApiAppId: pending.socketApiAppId,
      socketAppTokenConfigured: pending.socketAppTokenConfigured
    } }, 200);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "invalid_input" || code.startsWith("invalid-") || code === "required-user-scope-missing") return json({ error: "invalid_configuration" }, 400);
    if (code === "conflict" || code === "pending-conflict") return json({ error: "configuration_conflict" }, 409);
    if (code === "setup-session-unavailable") return json({ error: "session_expired" }, 401);
    if (code === "environment_locked") return json({ error: "environment_locked" }, 409);
    return json({ error: "configuration_unavailable" }, 503);
  }
}

export async function handleSlackConfigurationPost(request: NextRequest, dependencies: SlackConfigurationRouteDependencies): Promise<NextResponse> {
  const finish = (response: NextResponse) => clearSetupBrowserTransaction(secure(response), dependencies.secureBrowserTransactionCookie === true);
  const setupOrigin = dependencies.expectedOrigin ?? new URL(getSlackOAuthDeploymentConfig().publicBaseUrl).origin;
  if (request.nextUrl.search) return finish(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
  if (!isFormUrlEncodedContentType(request.headers.get("content-type"))) return finish(NextResponse.json({ error: "unsupported_media_type" }, { status: 415 }));
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return finish(NextResponse.json({ error: "request_too_large" }, { status: 413 }));
  const raw = await readBoundedText(request, MAX_BODY_BYTES);
  if (raw === null) return finish(NextResponse.json({ error: "request_too_large" }, { status: 413 }));
  const form = new URLSearchParams(raw);
  const keys = [...form.keys()];
  const allowed = new Set(["setupProof", "clientId", "clientSecret", "botScope", "userScope", "additionalBotScopes", "additionalUserScopes", "socketModeEnabled", "socketApiAppId", "socketAppToken", "socketCallbacksReviewed"]);
  if (keys.some((key) => !allowed.has(key)) || form.getAll("setupProof").length !== 1 || form.getAll("clientId").length !== 1 || form.getAll("clientSecret").length !== 1) return finish(configurationRedirect(setupOrigin, "invalid_configuration"));
  const proof = form.get("setupProof") ?? "";
  const clientId = form.get("clientId") ?? "";
  const clientSecret = form.get("clientSecret") ?? "";
  const additionalBotScopes = form.get("additionalBotScopes") ?? "";
  const additionalUserScopes = form.get("additionalUserScopes") ?? "";
  const socketModeEnabled = form.get("socketModeEnabled") === "1";
  const socketApiAppId = form.get("socketApiAppId") ?? "";
  const socketAppToken = form.get("socketAppToken") ?? "";
  const socketCallbacksReviewed = form.get("socketCallbacksReviewed") === "1";
  if (form.getAll("socketModeEnabled").length > 1 || form.getAll("socketApiAppId").length > 1 || form.getAll("socketAppToken").length > 1 || form.getAll("socketCallbacksReviewed").length > 1 || (socketModeEnabled && !socketCallbacksReviewed)) return finish(configurationRedirect(setupOrigin, "invalid_configuration"));
  if (form.getAll("additionalBotScopes").length > 1 || form.getAll("additionalUserScopes").length > 1 || additionalBotScopes.length > 4096 || additionalUserScopes.length > 4096) return finish(configurationRedirect(setupOrigin, "invalid_configuration"));
  const botScopes = [...form.getAll("botScope"), ...parseAdditionalScopes(additionalBotScopes)];
  const userScopes = [...form.getAll("userScope"), ...parseAdditionalScopes(additionalUserScopes)];
  if (proof.length < 64 || proof.length > 512 || clientId.length < 1 || clientId.length > 255 || clientSecret.length < 1 || clientSecret.length > 4096 || socketApiAppId.length > 32 || socketAppToken.length > 512 || botScopes.length > 64 || userScopes.length > 64 || [...botScopes, ...userScopes].some((scope) => scope.length < 1 || scope.length > 128)) return finish(configurationRedirect(setupOrigin, "invalid_configuration"));
  const csrf = rejectUnprovenSetupBrowserMutation(request, dependencies, proof);
  if (csrf) return finish(hasSafeSetupNavigationMetadata(request, setupOrigin) ? configurationRedirect(setupOrigin, "secure_form_expired") : csrf);

  const setupToken = request.cookies.get(setupSessionCookieName)?.value;
  if (!setupToken) return finish(configurationRedirect(setupOrigin, "session_expired"));
  const session = await dependencies.resolveSession(setupToken);
  if (!session) return finish(configurationRedirect(setupOrigin, "session_expired"));

  try {
    await dependencies.createPendingConfiguration({
      setupSessionId: session.id,
      expectedPendingVersionId: session.pendingConfigurationVersionId,
      clientId,
      clientSecret,
      botScopes,
      userScopes,
      socketModeEnabled,
      socketApiAppId,
      socketAppToken,
      requestId: randomUUID()
    });
    return finish(NextResponse.redirect(new URL("/setup", setupOrigin), 303));
  } catch (error) {
    return finish(configurationRedirect(setupOrigin, configurationErrorCode(error)));
  }
}

function parseAdditionalScopes(value: string): string[] {
  return value.split(/[\s,]+/).filter(Boolean);
}

function json(body: unknown, status: number): NextResponse {
  return secure(NextResponse.json(body, { status }));
}

function configurationErrorCode(error: unknown): "invalid_configuration" | "configuration_conflict" | "session_expired" | "environment_locked" | "configuration_unavailable" {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "invalid_input" || code.startsWith("invalid-") || code === "required-user-scope-missing") return "invalid_configuration";
  if (code === "conflict" || code === "pending-conflict") return "configuration_conflict";
  if (code === "setup-session-unavailable") return "session_expired";
  if (code === "environment_locked") return "environment_locked";
  return "configuration_unavailable";
}

function configurationRedirect(setupOrigin: string, error: ReturnType<typeof configurationErrorCode> | "secure_form_expired"): NextResponse {
  const url = new URL("/setup", setupOrigin);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}
