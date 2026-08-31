import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getRemoteCodexConfig, getSlackSigningSecret, isSetupRequiredError } from "@/src/server/config";
import { database } from "@/src/server/db";
import { scheduleAfterResponse } from "@/src/server/http/deferred-work";
import { publishRemoteCodexAppHome } from "@/src/server/remote-codex/app-home-service";
import { createDefaultRemoteCodexSlackService } from "@/src/server/remote-codex/internal-slack-service";
import { createRemoteCodexSlackRateLimiter } from "@/src/server/remote-codex/slack-rate-limit";
import { createPostgresSlackInboundReceiptStore } from "@/src/server/slack/inbound-receipts";
import { verifySlackInboundRequest } from "@/src/server/slack/inbound-signature";

export const dynamic = "force-dynamic";
const maxBodyBytes = 256 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const body = await request.text();
  if (Buffer.byteLength(body) > maxBodyBytes) return response({ error: "invalid_request" }, 400, requestId);
  try {
    if (!verifySlackInboundRequest({
      signingSecret: getSlackSigningSecret(),
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      rawBody: body
    })) return response({ error: "invalid_signature" }, 401, requestId);

    const payload = parseObject(body);
    if (!payload) return response({ error: "invalid_request" }, 400, requestId);
    if (payload.type === "url_verification" && typeof payload.challenge === "string") {
      return response({ challenge: payload.challenge }, 200, requestId);
    }
    const event = isRecord(payload.event) ? payload.event : null;
    if (payload.type !== "event_callback" || typeof payload.event_id !== "string" || typeof payload.team_id !== "string" || !event) {
      return response({ ok: true }, 200, requestId);
    }
    const teamId = safeSlackId(payload.team_id);
    const appId = typeof payload.api_app_id === "string" ? safeSlackId(payload.api_app_id) : null;
    const eventId = safeCallbackId(payload.event_id);
    const slackUserId = typeof event.user === "string" ? safeSlackId(event.user) : null;
    if (!teamId || !appId || !eventId || !slackUserId || !hasMatchingAuthorization(payload, teamId)) {
      return response({ ok: true }, 200, requestId);
    }

    const receipts = createPostgresSlackInboundReceiptStore(database);
    const claimed = await receipts.claim({
      teamId,
      callbackId: eventId,
      callbackType: "event",
      retryNumber: parseRetry(request.headers.get("x-slack-retry-num")),
      now: new Date()
    });
    if (!claimed) return response({ ok: true }, 200, requestId);
    if (event.type !== "app_home_opened") {
      await receipts.complete({ teamId, callbackId: eventId, callbackType: "event", status: "ignored", now: new Date() });
      return response({ ok: true }, 200, requestId);
    }
    try {
      const config = getRemoteCodexConfig();
      if (!config.enabled) {
        await receipts.complete({ teamId, callbackId: eventId, callbackType: "event", status: "ignored", now: new Date() });
        return response({ ok: true }, 200, requestId);
      }
      scheduleAfterResponse(async () => {
        try {
          const slack = await createDefaultRemoteCodexSlackService(createRemoteCodexSlackRateLimiter(database));
          const status = await publishRemoteCodexAppHome({
            database, slack, teamId, slackUserId, appId, requestId,
            connectUrl: `${config.publicBaseUrl}/remote-codex`
          });
          await receipts.complete({ teamId, callbackId: eventId, callbackType: "event", status: status === "unavailable" ? "failed" : "processed", now: new Date() });
        } catch {
          await receipts.complete({ teamId, callbackId: eventId, callbackType: "event", status: "failed", now: new Date() }).catch(() => undefined);
        }
      });
    } catch (error) {
      await receipts.complete({ teamId, callbackId: eventId, callbackType: "event", status: "failed", now: new Date() });
      throw error;
    }
    return response({ ok: true }, 200, requestId);
  } catch (error) {
    return response({ error: isSetupRequiredError(error) ? "setup_required" : "unavailable" }, 503, requestId);
  }
}

function parseObject(body: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(body); return isRecord(value) ? value : null; } catch { return null; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeSlackId(value: string): string | null { return /^[A-Z][A-Z0-9]{1,20}$/.test(value) ? value : null; }
function safeCallbackId(value: string): string | null { return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null; }
function parseRetry(value: string | null): number | null { const parsed = value === null ? NaN : Number(value); return Number.isInteger(parsed) && parsed >= 0 && parsed < 100 ? parsed : null; }
function hasMatchingAuthorization(payload: Record<string, unknown>, teamId: string): boolean {
  if (!Array.isArray(payload.authorizations) || payload.authorizations.length > 20) return false;
  const enterpriseId = typeof payload.enterprise_id === "string" ? safeSlackId(payload.enterprise_id) : null;
  return payload.authorizations.some((value) => {
    if (!isRecord(value) || value.is_bot !== true) return false;
    const authorizationTeam = typeof value.team_id === "string" ? safeSlackId(value.team_id) : null;
    const authorizationEnterprise = typeof value.enterprise_id === "string" ? safeSlackId(value.enterprise_id) : null;
    return authorizationTeam === teamId || Boolean(enterpriseId && authorizationEnterprise === enterpriseId);
  });
}
function response(body: unknown, status: number, requestId: string): NextResponse {
  const result = NextResponse.json(body, { status });
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Prism-Request-ID", requestId);
  return result;
}
