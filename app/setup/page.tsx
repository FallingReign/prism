import { cookies } from "next/headers";

import { getSlackOAuthDeploymentConfig } from "../../src/server/config";
import { createSetupBootstrapService } from "../../src/server/setup/bootstrap";
import { createPostgresSetupBootstrapStore } from "../../src/server/setup/bootstrap-postgres-store";
import { SLACK_SCOPE_CATALOG, selectAllPrismSupportedSlackScopes } from "../../src/server/slack/app-configuration";
import { createConfiguredSlackAppConfigurationResolver, type ResolvedSlackAppConfiguration } from "../../src/server/slack/app-configuration-factory";
import { database } from "../../src/server/db";
import { setupSessionCookieName } from "../v1/prism/setup/session/handler";
import { SetupView, type SetupScopeOption, type SetupViewState } from "./setup-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SetupPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const query = (await searchParams) ?? {};
  const deployment = getSlackOAuthDeploymentConfig();
  const resolver = createConfiguredSlackAppConfigurationResolver();
  const status = await resolver.getStatus();
  if (status.kind === "environment_locked") return <SetupView callbackUri={deployment.redirectUri} state={{ kind: "environment_locked", botScopes: status.summary.botScopes, userScopes: status.summary.userScopes }} />;

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(setupSessionCookieName)?.value;
  if (!sessionToken && status.kind === "active") return <SetupView callbackUri={deployment.redirectUri} state={{ kind: "complete" }} />;
  if (!sessionToken) {
    const error = query.error === "invalid_or_expired" || query.error === "rate_limited" || query.error === "session_expired" || query.error === "secure_form_expired" ? query.error : undefined;
    return <SetupView callbackUri={deployment.redirectUri} state={{ kind: "code_required", ...(error ? { error } : {}) }} />;
  }

  const setup = createSetupBootstrapService(createPostgresSetupBootstrapStore(database));
  const session = await setup.resolveSession(sessionToken);
  if (!session) return <SetupView callbackUri={deployment.redirectUri} state={{ kind: "code_required", error: "invalid_or_expired" }} />;

  let pending: ResolvedSlackAppConfiguration | null = null;
  let pendingUnavailable = false;
  if (session.pendingConfigurationVersionId) {
    try {
      pending = await resolver.resolvePendingForSetupSession({ setupSessionId: session.id });
    } catch {
      pendingUnavailable = true;
    }
  }
  const defaults = selectAllPrismSupportedSlackScopes();
  const state: SetupViewState = {
    kind: "configure",
    scopes: scopeOptions(),
    selectedBotScopes: defaults.botScopes,
    selectedUserScopes: defaults.userScopes,
    pending: pending ? {
      clientId: pending.summary.clientId,
      secretStored: true,
      botScopes: pending.summary.botScopes,
      userScopes: pending.summary.userScopes,
      socketModeEnabled: pending.summary.socketModeEnabled,
      socketApiAppId: pending.summary.socketApiAppId,
      socketAppTokenConfigured: pending.summary.socketAppTokenConfigured,
      version: pending.summary.version ?? "unknown"
    } : null,
    ...(() => {
      const allowed = new Set(["verification_unavailable", "invalid_configuration", "configuration_conflict", "session_expired", "environment_locked", "configuration_unavailable", "secure_form_expired"] as const);
      const error = pendingUnavailable ? "verification_unavailable" : typeof query.error === "string" && allowed.has(query.error as never) ? query.error : undefined;
      return error ? { error: error as NonNullable<Extract<SetupViewState, { kind: "configure" }>["error"]> } : {};
    })()
  };
  return <SetupView callbackUri={deployment.redirectUri} state={state} />;
}

function scopeOptions(): SetupScopeOption[] {
  return SLACK_SCOPE_CATALOG.map((scope) => ({ id: scope.id, label: scope.id, description: scope.help, tokenKind: scope.tokenKind, required: scope.required }));
}
