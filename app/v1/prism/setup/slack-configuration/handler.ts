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
type RedactedPending = { clientId: string; version: string; botScopes: string[]; userScopes: string[] };

export type SlackConfigurationRouteDependencies = SetupBrowserMutationProof & {
  resolveSession(token: string): Promise<SetupContext | null>;
  createPendingConfiguration(input: {
    setupSessionId: string;
    expectedPendingVersionId: string | null;
    clientId: unknown;
    clientSecret: unknown;
    botScopes: unknown;
    userScopes: unknown;
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
    const allowedKeys = new Set(["clientId", "clientSecret", "botScopes", "userScopes"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) return json({ error: "invalid_configuration" }, 400);
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
      requestId: randomUUID()
    });
    return json({ configuration: { clientId: pending.clientId, version: pending.version, secretStored: true, botScopes: pending.botScopes, userScopes: pending.userScopes } }, 200);
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
  const allowed = new Set(["setupProof", "clientId", "clientSecret", "botScope", "userScope"]);
  if (keys.some((key) => !allowed.has(key)) || form.getAll("setupProof").length !== 1 || form.getAll("clientId").length !== 1 || form.getAll("clientSecret").length !== 1) return finish(configurationRedirect(setupOrigin, "invalid_configuration"));
  const proof = form.get("setupProof") ?? "";
  const clientId = form.get("clientId") ?? "";
  const clientSecret = form.get("clientSecret") ?? "";
  const botScopes = form.getAll("botScope");
  const userScopes = form.getAll("userScope");
  if (proof.length < 64 || proof.length > 512 || clientId.length < 1 || clientId.length > 255 || clientSecret.length < 1 || clientSecret.length > 4096 || botScopes.length > 64 || userScopes.length > 64 || new Set(botScopes).size !== botScopes.length || new Set(userScopes).size !== userScopes.length || [...botScopes, ...userScopes].some((scope) => scope.length < 1 || scope.length > 128)) return finish(configurationRedirect(setupOrigin, "invalid_configuration"));
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
      requestId: randomUUID()
    });
    return finish(NextResponse.redirect(new URL("/setup", setupOrigin), 303));
  } catch (error) {
    return finish(configurationRedirect(setupOrigin, configurationErrorCode(error)));
  }
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
