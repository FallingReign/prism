import "server-only";

import { getSlackOAuthConfig, isSetupRequiredError } from "../config";
import { createConfiguredCredentialCipher } from "../credentials/factory";
import type { Database } from "../db";
import { enrichSlackConnectionDisplayNames, needsSlackConnectionDisplayNameEnrichment, type SlackConnectionDisplayNameStore } from "./connection-display-names";
import { createSlackForwardingCredentialProvider, type SlackForwardingCredentialProvider } from "./forwarding-credentials";
import { createFetchSlackOAuthClient } from "./oauth-client";
import {
  createPostgresRefreshStore,
  createPostgresSlackConnectionDisplayNameStore,
  getSlackConnectionDisplayRecordForSession,
  toSlackLinkStatus,
  type SlackLinkStatus
} from "./postgres-store";
import { createDefaultSlackWebApiClient, type SlackWebApiClient } from "./web-api-client";

export async function getSlackLinkStatusWithDisplayNameEnrichment({
  database,
  sessionToken,
  displayNameStore,
  credentialProvider,
  webApiClient,
  now = new Date()
}: {
  database: Database;
  sessionToken: string | undefined;
  displayNameStore?: SlackConnectionDisplayNameStore;
  credentialProvider?: SlackForwardingCredentialProvider;
  webApiClient?: SlackWebApiClient;
  now?: Date;
}): Promise<SlackLinkStatus> {
  const connection = await getSlackConnectionDisplayRecordForSession(database, sessionToken);
  if (!connection) return { kind: "not_linked" };

  if (!needsSlackConnectionDisplayNameEnrichment(connection)) return toSlackLinkStatus(connection);

  const dependencies = resolveDisplayNameDependencies({ database, displayNameStore, credentialProvider, webApiClient });
  if (!dependencies) return toSlackLinkStatus(connection);

  try {
    const enriched = await enrichSlackConnectionDisplayNames({
      connection,
      store: dependencies.displayNameStore,
      credentialProvider: dependencies.credentialProvider,
      webApiClient: dependencies.webApiClient,
      now
    });
    return toSlackLinkStatus(enriched);
  } catch (error) {
    console.error("prism_slack_connection_display_name_enrichment_failed", {
      connectionId: connection.connectionId,
      errorName: error instanceof Error ? error.name : typeof error
    });
    return toSlackLinkStatus(connection);
  }
}

function resolveDisplayNameDependencies({
  database,
  displayNameStore,
  credentialProvider,
  webApiClient
}: {
  database: Database;
  displayNameStore?: SlackConnectionDisplayNameStore;
  credentialProvider?: SlackForwardingCredentialProvider;
  webApiClient?: SlackWebApiClient;
}):
  | {
      displayNameStore: SlackConnectionDisplayNameStore;
      credentialProvider: SlackForwardingCredentialProvider;
      webApiClient: SlackWebApiClient;
    }
  | null {
  if (displayNameStore && credentialProvider && webApiClient) {
    return { displayNameStore, credentialProvider, webApiClient };
  }

  try {
    const cipher = createConfiguredCredentialCipher();
    let slackOAuthClient: ReturnType<typeof createFetchSlackOAuthClient> | undefined;
    try {
      const config = getSlackOAuthConfig();
      slackOAuthClient = createFetchSlackOAuthClient({ clientId: config.clientId, clientSecret: config.clientSecret });
    } catch (error) {
      if (!isSetupRequiredError(error)) throw error;
    }

    return {
      displayNameStore: displayNameStore ?? createPostgresSlackConnectionDisplayNameStore(database),
      credentialProvider:
        credentialProvider ??
        createSlackForwardingCredentialProvider({
          store: createPostgresRefreshStore(database),
          cipher,
          slackOAuthClient
        }),
      webApiClient: webApiClient ?? createDefaultSlackWebApiClient()
    };
  } catch (error) {
    if (isSetupRequiredError(error)) return null;
    throw error;
  }
}
