import { NextRequest, type NextResponse } from "next/server";

import { database } from "../../../../../../src/server/db";
import { createSetupBootstrapService } from "../../../../../../src/server/setup/bootstrap";
import { createPostgresSetupBootstrapStore } from "../../../../../../src/server/setup/bootstrap-postgres-store";
import { createConfiguredSlackAppConfigurationResolver } from "../../../../../../src/server/slack/app-configuration-factory";
import { createSlackOAuthStart } from "../../../../../../src/server/slack/oauth-flow";
import { createPostgresOAuthFlowStore } from "../../../../../../src/server/slack/postgres-store";
import { handleSlackConfigurationVerifyPost } from "./handler";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const setup = createSetupBootstrapService(createPostgresSetupBootstrapStore(database));
  const resolver = createConfiguredSlackAppConfigurationResolver();
  return handleSlackConfigurationVerifyPost(request, {
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
