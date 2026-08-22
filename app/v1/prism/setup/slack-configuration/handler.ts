import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOriginBrowserMutation } from "../../../../../src/server/http/browser-mutation-csrf";
import { readBoundedText, setupSessionCookieName, secure } from "../session/handler";

const MAX_BODY_BYTES = 16 * 1024;

type SetupContext = { id: string; pendingConfigurationVersionId: string | null };
type RedactedPending = { clientId: string; version: string; botScopes: string[]; userScopes: string[] };

export type SlackConfigurationRouteDependencies = {
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

function json(body: unknown, status: number): NextResponse {
  return secure(NextResponse.json(body, { status }));
}
