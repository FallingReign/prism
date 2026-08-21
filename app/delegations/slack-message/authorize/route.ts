import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { getDelegatedDeliveryConfig } from "../../../../src/server/config";
import { createConfiguredCredentialCipher } from "../../../../src/server/credentials/factory";
import { database } from "../../../../src/server/db";
import { delegatedHtmlResponse, delegatedRedirect } from "../../../../src/server/delegated-delivery/http";
import { createPostgresDelegatedDeliveryStore } from "../../../../src/server/delegated-delivery/postgres-store";
import { renderDelegatedConsentErrorPage, renderDelegatedConsentPage } from "../../../../src/server/delegated-delivery/presentation";
import { resolveDelegationConsent } from "../../../../src/server/delegated-delivery/service";
import { prismSessionCookieName } from "../../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const correlationId = randomUUID();
  try {
    const config = getDelegatedDeliveryConfig();
    if (!config.enabled) return errorPage(404, correlationId);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "request") || url.searchParams.getAll("request").length !== 1) {
      return errorPage(404, correlationId);
    }
    const decision = await resolveDelegationConsent({
      handle: url.searchParams.get("request"),
      sessionToken: request.cookies.get(prismSessionCookieName)?.value,
      store: createPostgresDelegatedDeliveryStore(database),
      cipher: createConfiguredCredentialCipher(),
      config
    });
    if (decision.kind === "redirect") return delegatedRedirect(decision.location, 302, correlationId);
    if (decision.kind === "preview") return delegatedHtmlResponse(renderDelegatedConsentPage(decision.preview), 200, correlationId);
    return errorPage(decision.status, correlationId);
  } catch {
    return errorPage(500, correlationId);
  }
}

function errorPage(status: number, requestId: string) {
  return delegatedHtmlResponse(renderDelegatedConsentErrorPage(status), status, requestId);
}
