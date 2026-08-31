import { createHash, randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getRemoteCodexConfig, getSlackSigningSecret, isSetupRequiredError } from "@/src/server/config";
import { database } from "@/src/server/db";
import { scheduleAfterResponse } from "@/src/server/http/deferred-work";
import { createPostgresBindingStore } from "@/src/server/remote-codex/binding-postgres-store";
import { createRemoteCodexBindingService } from "@/src/server/remote-codex/binding-service";
import { createDefaultRemoteCodexSlackService } from "@/src/server/remote-codex/internal-slack-service";
import { decodeSessionAction } from "@/src/server/remote-codex/slack-projection";
import { createRemoteCodexSlackRateLimiter } from "@/src/server/remote-codex/slack-rate-limit";
import { createPostgresSlackInboundReceiptStore } from "@/src/server/slack/inbound-receipts";
import { verifySlackInboundRequest } from "@/src/server/slack/inbound-signature";

export const dynamic = "force-dynamic";
const maxBodyBytes = 256 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > maxBodyBytes) return response({ error: "invalid_request" }, 400, requestId);
  try {
    if (!verifySlackInboundRequest({
      signingSecret: getSlackSigningSecret(),
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      rawBody
    })) return response({ error: "invalid_signature" }, 401, requestId);

    const payloadText = new URLSearchParams(rawBody).get("payload");
    const payload = payloadText ? parseObject(payloadText) : null;
    const team = payload && isRecord(payload.team) ? payload.team : null;
    const user = payload && isRecord(payload.user) ? payload.user : null;
    const teamId = team && typeof team.id === "string" ? safeSlackId(team.id) : null;
    const appId = payload && typeof payload.api_app_id === "string" ? safeSlackId(payload.api_app_id) : null;
    const slackUserId = user && typeof user.id === "string" ? safeSlackId(user.id) : null;
    const actions = payload && Array.isArray(payload.actions) ? payload.actions : [];
    const action = actions.length === 1 && isRecord(actions[0]) ? actions[0] : null;
    if (!payload || payload.type !== "block_actions" || !teamId || !appId || !slackUserId || !action || action.action_id !== "remote_codex_share_session" || typeof action.value !== "string") {
      return response({ ok: true }, 200, requestId);
    }
    const selected = decodeSessionAction(action.value);
    if (!selected) return response({ ok: true }, 200, requestId);
    if (!getRemoteCodexConfig().enabled) return response({ ok: true }, 200, requestId);

    const callbackId = createHash("sha256").update(rawBody).digest("base64url");
    const receipts = createPostgresSlackInboundReceiptStore(database);
    if (!await receipts.claim({ teamId, callbackId, callbackType: "interaction", retryNumber: null, now: new Date() })) {
      return response({ ok: true }, 200, requestId);
    }
    try {
      scheduleAfterResponse(async () => {
        try {
          const binding = createRemoteCodexBindingService({
            store: createPostgresBindingStore(database),
            slack: await createDefaultRemoteCodexSlackService(createRemoteCodexSlackRateLimiter(database))
          });
          const result = await binding.attach({ source: "slack", teamId, appId, slackUserId, ...selected, requestId });
          await receipts.complete({
            teamId, callbackId, callbackType: "interaction",
            status: result.kind === "unavailable" ? "failed" : result.kind === "not_found" ? "ignored" : "processed",
            now: new Date()
          });
        } catch {
          await receipts.complete({ teamId, callbackId, callbackType: "interaction", status: "failed", now: new Date() }).catch(() => undefined);
        }
      });
    } catch (error) {
      await receipts.complete({ teamId, callbackId, callbackType: "interaction", status: "failed", now: new Date() });
      throw error;
    }
    return response({ ok: true }, 200, requestId);
  } catch (error) {
    return response({ error: isSetupRequiredError(error) ? "setup_required" : "unavailable" }, 503, requestId);
  }
}

function parseObject(body: string): Record<string, unknown> | null { try { const value: unknown = JSON.parse(body); return isRecord(value) ? value : null; } catch { return null; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeSlackId(value: string): string | null { return /^[A-Z][A-Z0-9]{1,20}$/.test(value) ? value : null; }
function response(body: unknown, status: number, requestId: string): NextResponse {
  const result = NextResponse.json(body, { status });
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Prism-Request-ID", requestId);
  return result;
}
