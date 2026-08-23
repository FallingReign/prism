import { NextRequest, type NextResponse } from "next/server";

import { getCredentialEncryptionConfig, getSlackOAuthDeploymentConfig, getSlackOAuthEnvironmentBundle } from "../../../../../src/server/config";
import { createConfiguredCredentialCipher } from "../../../../../src/server/credentials/factory";
import { database } from "../../../../../src/server/db";
import { createSetupBootstrapService } from "../../../../../src/server/setup/bootstrap";
import { createPostgresSetupBootstrapStore } from "../../../../../src/server/setup/bootstrap-postgres-store";
import { createSetupBrowserTransactionService, deriveSetupBrowserTransactionKey } from "../../../../../src/server/setup/browser-transaction";
import { createPostgresSlackAppConfigurationStore } from "../../../../../src/server/slack/app-configuration-postgres-store";
import { handleSlackConfigurationPost, handleSlackConfigurationPut, type SlackConfigurationRouteDependencies } from "./handler";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest): Promise<NextResponse> {
  return handleSlackConfigurationPut(request, createDependencies());
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const encryption = getCredentialEncryptionConfig();
  const deployment = getSlackOAuthDeploymentConfig();
  const browserTransaction = createSetupBrowserTransactionService({ key: deriveSetupBrowserTransactionKey(Buffer.from(encryption.key, "base64")) });
  return handleSlackConfigurationPost(request, {
    ...createDependencies(),
    expectedOrigin: new URL(deployment.publicBaseUrl).origin,
    secureBrowserTransactionCookie: deployment.publicBaseUrl.startsWith("https://"),
    validateBrowserTransaction: (cookieValue, proof) => browserTransaction.validate(cookieValue, proof)
  });
}

function createDependencies(): SlackConfigurationRouteDependencies {
  const setup = createSetupBootstrapService(createPostgresSetupBootstrapStore(database));
  const configurations = createPostgresSlackAppConfigurationStore(database, createConfiguredCredentialCipher());
  return {
    resolveSession: (token) => setup.resolveSession(token),
    async createPendingConfiguration(input) {
      const environment = getSlackOAuthEnvironmentBundle();
      if (environment && !environment.mockOAuth) throw Object.assign(new Error("environment_locked"), { code: "environment_locked" });
      const pending = await configurations.createPendingConfiguration({
        setupSessionId: input.setupSessionId,
        expectedPendingVersionId: input.expectedPendingVersionId,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        botScopes: input.botScopes as readonly string[] | null | undefined,
        userScopes: input.userScopes as readonly string[] | null | undefined,
        createdVia: "bootstrap",
        createdByPrismUserId: null,
        audit: { endpoint: "/v1/prism/setup/slack-configuration", requestId: input.requestId }
      });
      return { clientId: pending.clientId, version: pending.version, botScopes: pending.botScopes, userScopes: pending.userScopes };
    }
  };
}
