import { NextRequest, type NextResponse } from "next/server";

import {
  getCredentialEncryptionConfig,
  getSetupAbuseProtectionConfig,
  getSlackOAuthDeploymentConfig
} from "../../../../../src/server/config";
import { database } from "../../../../../src/server/db";
import {
  createSetupBootstrapService,
  deriveSetupRateLimitSourceKey
} from "../../../../../src/server/setup/bootstrap";
import { createPostgresSetupBootstrapStore } from "../../../../../src/server/setup/bootstrap-postgres-store";
import { createSetupBrowserTransactionService, deriveSetupBrowserTransactionKey } from "../../../../../src/server/setup/browser-transaction";
import { handleSetupSessionPost } from "./handler";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const encryption = getCredentialEncryptionConfig();
  const service = createSetupBootstrapService(createPostgresSetupBootstrapStore(database), {
    sourceHashKey: deriveSetupRateLimitSourceKey(Buffer.from(encryption.key, "base64"))
  });
  const abuseProtection = getSetupAbuseProtectionConfig();
  const deployment = getSlackOAuthDeploymentConfig();
  const browserTransaction = createSetupBrowserTransactionService({
    key: deriveSetupBrowserTransactionKey(Buffer.from(encryption.key, "base64"))
  });
  return handleSetupSessionPost(request, {
    trustProxyHeaders: abuseProtection.trustProxyHeaders,
    expectedOrigin: new URL(deployment.publicBaseUrl).origin,
    secureBrowserTransactionCookie: deployment.publicBaseUrl.startsWith("https://"),
    validateBrowserTransaction: (cookieValue, proof) => browserTransaction.validate(cookieValue, proof),
    async exchangeCapability(input) {
      const exchanged = await service.exchangeCapability(input);
      return exchanged ? { sessionToken: exchanged.sessionToken, expiresAt: exchanged.session.expiresAt } : null;
    }
  });
}
