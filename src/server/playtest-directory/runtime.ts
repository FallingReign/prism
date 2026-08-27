import "server-only";

import { createConfiguredCredentialCipher } from "../credentials/factory";
import { database } from "../db";
import { createConfiguredSlackOAuthClient } from "../slack/app-configuration-factory";
import { createSlackForwardingCredentialProvider } from "../slack/forwarding-credentials";
import { createPostgresRefreshStore } from "../slack/postgres-store";
import { createDefaultSlackWebApiClient } from "../slack/web-api-client";
import { createPostgresTokenProfileStore } from "../token-profiles/store";
import { createPostgresPlaytestDirectoryStore } from "./postgres-store";

export async function createPlaytestDirectoryRuntime() {
  return {
    authStore: createPostgresTokenProfileStore(database),
    directoryStore: createPostgresPlaytestDirectoryStore(database),
    credentialProvider: createSlackForwardingCredentialProvider({
      store: createPostgresRefreshStore(database),
      cipher: createConfiguredCredentialCipher(),
      slackOAuthClient: await createConfiguredSlackOAuthClient({ database })
    }),
    slackClient: createDefaultSlackWebApiClient()
  };
}
