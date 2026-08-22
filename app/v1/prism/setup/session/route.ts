import { NextRequest, type NextResponse } from "next/server";

import {
  getCredentialEncryptionConfig,
  getSetupAbuseProtectionConfig
} from "../../../../../src/server/config";
import { database } from "../../../../../src/server/db";
import {
  createSetupBootstrapService,
  deriveSetupRateLimitSourceKey
} from "../../../../../src/server/setup/bootstrap";
import { createPostgresSetupBootstrapStore } from "../../../../../src/server/setup/bootstrap-postgres-store";
import { handleSetupSessionPost } from "./handler";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const encryption = getCredentialEncryptionConfig();
  const service = createSetupBootstrapService(createPostgresSetupBootstrapStore(database), {
    sourceHashKey: deriveSetupRateLimitSourceKey(Buffer.from(encryption.key, "base64"))
  });
  const abuseProtection = getSetupAbuseProtectionConfig();
  return handleSetupSessionPost(request, {
    trustProxyHeaders: abuseProtection.trustProxyHeaders,
    async exchangeCapability(input) {
      const exchanged = await service.exchangeCapability(input);
      return exchanged ? { sessionToken: exchanged.sessionToken, expiresAt: exchanged.session.expiresAt } : null;
    }
  });
}
