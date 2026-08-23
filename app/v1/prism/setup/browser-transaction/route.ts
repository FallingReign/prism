import { NextRequest, type NextResponse } from "next/server";

import { getCredentialEncryptionConfig, getSlackOAuthDeploymentConfig } from "../../../../../src/server/config";
import { createSetupBrowserTransactionService, deriveSetupBrowserTransactionKey } from "../../../../../src/server/setup/browser-transaction";
import { handleSetupBrowserTransactionGet } from "./handler";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const encryption = getCredentialEncryptionConfig();
  const service = createSetupBrowserTransactionService({ key: deriveSetupBrowserTransactionKey(Buffer.from(encryption.key, "base64")) });
  return handleSetupBrowserTransactionGet(request, {
    issue: () => service.issue(),
    secureCookie: getSlackOAuthDeploymentConfig().publicBaseUrl.startsWith("https://")
  });
}
