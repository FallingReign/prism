import { existsSync, readFileSync } from "node:fs";

import { getSlackOAuthConfig, isSetupRequiredError } from "../src/server/config";
import { createConfiguredCredentialCipher } from "../src/server/credentials/factory";
import { database } from "../src/server/db";
import { enrichSlackConnectionDisplayNames, type SlackConnectionDisplayRecord } from "../src/server/slack/connection-display-names";
import { createSlackForwardingCredentialProvider } from "../src/server/slack/forwarding-credentials";
import { createFetchSlackOAuthClient } from "../src/server/slack/oauth-client";
import { createPostgresRefreshStore, createPostgresSlackConnectionDisplayNameStore } from "../src/server/slack/postgres-store";
import { createDefaultSlackWebApiClient } from "../src/server/slack/web-api-client";

loadEnvFile(".env.local");
loadEnvFile(".env.example");

const limit = parseLimit(process.argv.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length));
const connections = await listConnectionsNeedingDisplayNameEnrichment(limit);
const displayNameStore = createPostgresSlackConnectionDisplayNameStore(database);
const credentialProvider = createSlackForwardingCredentialProvider({
  store: createPostgresRefreshStore(database),
  cipher: createConfiguredCredentialCipher(),
  slackOAuthClient: createOptionalSlackOAuthClient()
});
const webApiClient = createDefaultSlackWebApiClient();

let updated = 0;
let failed = 0;

for (const connection of connections) {
  try {
    const enriched = await enrichSlackConnectionDisplayNames({
      connection,
      store: displayNameStore,
      credentialProvider,
      webApiClient
    });
    if (enriched.displayNamesEnrichedAt) updated += 1;
  } catch (error) {
    failed += 1;
    console.error("prism_slack_connection_display_name_backfill_failed", {
      connectionId: connection.connectionId,
      errorName: error instanceof Error ? error.name : typeof error
    });
  }
}

console.log(`Slack connection display-name backfill complete. processed=${connections.length} updated=${updated} failed=${failed}`);

async function listConnectionsNeedingDisplayNameEnrichment(limit: number): Promise<SlackConnectionDisplayRecord[]> {
  const result = await database.query<{
    id: string;
    status: "healthy" | "reauth_required";
    team_id: string | null;
    team_name: string | null;
    enterprise_id: string | null;
    enterprise_name: string | null;
    authed_user_id: string;
    authed_user_display_name: string | null;
    display_names_enriched_at: Date | null;
    last_error_class: string | null;
  }>(
    `select id, status, nullif(team_id, '') as team_id, nullif(team_name, '') as team_name,
            enterprise_id, nullif(enterprise_name, '') as enterprise_name,
            authed_user_id, nullif(authed_user_display_name, '') as authed_user_display_name,
            display_names_enriched_at, last_error_class
     from slack_connections
     where status = 'healthy'
       and display_names_enriched_at is null
       and ((nullif(team_id, '') is not null and nullif(team_name, '') is null)
         or (nullif(enterprise_id, '') is not null and nullif(enterprise_name, '') is null)
         or nullif(authed_user_display_name, '') is null)
     order by updated_at desc
     limit $1`,
    [limit]
  );

  return result.rows.map((row) => ({
    connectionId: row.id,
    status: row.status,
    teamId: row.team_id,
    teamName: row.team_name,
    enterpriseId: row.enterprise_id,
    enterpriseName: row.enterprise_name,
    slackUserId: row.authed_user_id,
    slackUserDisplayName: row.authed_user_display_name,
    displayNamesEnrichedAt: row.display_names_enriched_at,
    lastErrorClass: row.last_error_class
  }));
}

function createOptionalSlackOAuthClient(): ReturnType<typeof createFetchSlackOAuthClient> | undefined {
  try {
    const config = getSlackOAuthConfig();
    return createFetchSlackOAuthClient({ clientId: config.clientId, clientSecret: config.clientSecret });
  } catch (error) {
    if (isSetupRequiredError(error)) return undefined;
    throw error;
  }
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 100;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 100;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
