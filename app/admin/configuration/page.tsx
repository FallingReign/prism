import { cookies } from "next/headers";

import { AdminAllowlistUnavailableError, loadAdminAllowlist } from "../../../src/server/admin/allowlist";
import { resolvePrismAdmin } from "../../../src/server/admin/authorization";
import { createPostgresAdminIdentityStore } from "../../../src/server/admin/postgres-store";
import { getSlackOAuthDeploymentConfig } from "../../../src/server/config";
import { database } from "../../../src/server/db";
import { createConfiguredSlackAppConfigurationResolver } from "../../../src/server/slack/app-configuration-factory";
import { prismSessionCookieName } from "../../../src/server/slack/oauth-flow";
import { AdminAccessDenied } from "../admin-shell";
import { AdminConfigurationView, type AdminConfigurationSummary } from "./configuration-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminConfigurationPage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(prismSessionCookieName)?.value;
  if (!(await canReadConfiguration(sessionToken))) return <AdminAccessDenied />;

  const deployment = getSlackOAuthDeploymentConfig();
  const status = await createConfiguredSlackAppConfigurationResolver().getStatus();
  if (status.kind === "setup_required") return <AdminAccessDenied />;
  if (status.kind === "environment_locked") return <AdminConfigurationView callbackUri={deployment.redirectUri} configuration={{ source: "environment", secretConfigured: true, botScopes: status.summary.botScopes, userScopes: status.summary.userScopes, activatedAt: null, activatedBy: null }} />;
  const activation = status.summary.id
    ? await readActivationMetadata(status.summary.id)
    : null;
  const configuration: AdminConfigurationSummary = {
    source: "database",
    version: status.summary.version ?? undefined,
    secretConfigured: true,
    botScopes: status.summary.botScopes,
    userScopes: status.summary.userScopes,
    activatedAt: activation?.activatedAt ?? null,
    activatedBy: activation?.activatedBy ?? null
  };
  return <AdminConfigurationView callbackUri={deployment.redirectUri} configuration={configuration} />;
}

async function readActivationMetadata(configurationVersionId: string): Promise<{
  activatedAt: string | null;
  activatedBy: string | null;
} | null> {
  const result = await database.query<{
    activated_at: Date | string | null;
    prism_user_id: string | null;
    slack_user_id: string | null;
  }>(
    `select v.activated_at,
            coalesce(s.claimed_by_prism_user_id, v.created_by_prism_user_id) as prism_user_id,
            u.slack_user_id
       from prism_slack_app_configuration_versions v
       left join prism_setup_sessions s on s.id = v.setup_session_id
       left join prism_users u
         on u.id = coalesce(s.claimed_by_prism_user_id, v.created_by_prism_user_id)
      where v.id = $1 and v.status = 'active'
      limit 1`,
    [configurationVersionId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const activatedAt = row.activated_at instanceof Date
    ? row.activated_at.toISOString()
    : row.activated_at;
  return {
    activatedAt,
    activatedBy: row.slack_user_id ?? row.prism_user_id
  };
}

async function canReadConfiguration(sessionToken: string | undefined): Promise<boolean> {
  if (!sessionToken) return false;
  const identityStore = createPostgresAdminIdentityStore(database);
  const identity = await identityStore.getCurrentIdentity({ sessionToken, now: new Date() });
  if (!identity) return false;
  const claimed = await database.query<{ authorized: boolean }>(
    `select exists (
       select 1 from prism_configuration_admins
       where prism_user_id = $1
         and role = 'global_configuration_admin'
         and revoked_at is null
     ) as authorized`,
    [identity.prismUserId]
  );
  if (claimed.rows[0]?.authorized) return true;

  try {
    const decision = await resolvePrismAdmin({ store: identityStore, allowlist: await loadAdminAllowlist(), sessionToken });
    return decision.kind === "authorized" && decision.scope.kind === "global";
  } catch (error) {
    if (error instanceof AdminAllowlistUnavailableError) return false;
    throw error;
  }
}
