import { NextRequest, type NextResponse } from "next/server";

import { getCredentialEncryptionConfig, getSlackOAuthDeploymentConfig } from "../../../../../../src/server/config";
import { database } from "../../../../../../src/server/db";
import { createSetupBootstrapService } from "../../../../../../src/server/setup/bootstrap";
import { createPostgresSetupBootstrapStore } from "../../../../../../src/server/setup/bootstrap-postgres-store";
import { createSetupBrowserTransactionService, deriveSetupBrowserTransactionKey } from "../../../../../../src/server/setup/browser-transaction";
import { createConfiguredSlackAppConfigurationResolver } from "../../../../../../src/server/slack/app-configuration-factory";
import { createSlackOAuthStart } from "../../../../../../src/server/slack/oauth-flow";
import { createPostgresOAuthFlowStore } from "../../../../../../src/server/slack/postgres-store";
import { handleSlackConfigurationVerifyPost } from "./handler";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const setup = createSetupBootstrapService(createPostgresSetupBootstrapStore(database));
  const resolver = createConfiguredSlackAppConfigurationResolver();
  const encryption = getCredentialEncryptionConfig();
  const deployment = getSlackOAuthDeploymentConfig();
  const browserTransaction = createSetupBrowserTransactionService({ key: deriveSetupBrowserTransactionKey(Buffer.from(encryption.key, "base64")) });
  return handleSlackConfigurationVerifyPost(request, {
    expectedOrigin: new URL(deployment.publicBaseUrl).origin,
    secureBrowserTransactionCookie: deployment.publicBaseUrl.startsWith("https://"),
    validateBrowserTransaction: (cookieValue, proof) => browserTransaction.validate(cookieValue, proof),
    async startVerification({ setupSessionToken }) {
      try {
        const session = await setup.resolveSession(setupSessionToken);
        if (!session) return null;
        const pending = await resolver.resolvePendingForSetupSession({ setupSessionId: session.id });
        const start = await createSlackOAuthStart({
          store: createPostgresOAuthFlowStore(database),
          config: pending.oauthConfig,
          configurationBinding: pending.binding
        });
        return { redirectUrl: start.redirectUrl, cookie: start.cookie };
      } catch {
        return null;
      }
    }
  });
}
