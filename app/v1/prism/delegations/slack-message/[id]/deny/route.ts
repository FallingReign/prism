import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { getDelegatedDeliveryConfig } from "../../../../../../../src/server/config";
import { createConfiguredCredentialCipher } from "../../../../../../../src/server/credentials/factory";
import { database } from "../../../../../../../src/server/db";
import { delegatedHtmlResponse, delegatedRedirect, readBoundedUtf8Body } from "../../../../../../../src/server/delegated-delivery/http";
import { createPostgresDelegatedDeliveryStore } from "../../../../../../../src/server/delegated-delivery/postgres-store";
import { renderDelegatedConsentCsrfErrorPage, renderDelegatedConsentErrorPage } from "../../../../../../../src/server/delegated-delivery/presentation";
import { denyDelegationRequest } from "../../../../../../../src/server/delegated-delivery/service";
import { rejectCrossOriginBrowserMutation } from "../../../../../../../src/server/http/browser-mutation-csrf";
import { prismSessionCookieName } from "../../../../../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> | { id: string } };

export async function POST(request: NextRequest, context: RouteContext) {
  const correlationId = randomUUID();
  try {
    const config = getDelegatedDeliveryConfig();
    if (!config.enabled) return errorPage(404, correlationId);
    if (rejectCrossOriginBrowserMutation(request)) {
      return csrfErrorPage(correlationId);
    }
    if (!(await hasExactEmptyForm(request))) {
      return errorPage(400, correlationId);
    }
    const { id } = await context.params;
    const decision = await denyDelegationRequest({
      requestId: id,
      sessionToken: request.cookies.get(prismSessionCookieName)?.value,
      store: createPostgresDelegatedDeliveryStore(database),
      cipher: createConfiguredCredentialCipher(),
      config
    });
    return decision.kind === "redirect"
      ? delegatedRedirect(decision.location, 303, correlationId)
      : errorPage(decision.status, correlationId);
  } catch {
    return errorPage(500, correlationId);
  }
}

function errorPage(status: number, requestId: string) {
  return delegatedHtmlResponse(renderDelegatedConsentErrorPage(status), status, requestId);
}

function csrfErrorPage(requestId: string) {
  return delegatedHtmlResponse(renderDelegatedConsentCsrfErrorPage(), 403, requestId);
}

async function hasExactEmptyForm(request: NextRequest): Promise<boolean> {
  if (new URL(request.url).search || request.headers.has("authorization")) return false;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return false;
  const body = await readBoundedUtf8Body(request, 1024);
  return body !== null && [...new URLSearchParams(body).keys()].length === 0;
}
