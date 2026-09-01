import "server-only";

import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

import type { CredentialCipher, CredentialEnvelope } from "../credentials/encryption";
import type { SlackAppConfigurationBinding } from "./app-configuration";
import type { SlackOAuthClient, SlackOAuthSuccess } from "./oauth-client";
import type { OrganizationWorkspaceDiscoveryResult, SlackOrganizationWorkspace } from "./organization-workspaces";

export const slackOAuthStateCookieName = "prism_slack_oauth_state";
export const prismSessionCookieName = "prism_session";

export type SlackOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  publicBaseUrl: string;
  botScopes: string[];
  userScopes: string[];
};

export type CookieSpec = {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

export type OAuthFlowStore = {
  transaction<T>(callback: (store: OAuthFlowStore) => Promise<T>): Promise<T>;
  saveOAuthState(input: {
    stateHash: string;
    redirectUri: string;
    configurationBinding: SlackAppConfigurationBinding;
    oidcAuthorizationRequestId?: string | null;
    delegatedDeliveryRequestId?: string | null;
    localAppAuthorizationId?: string | null;
    expiresAt: Date;
  }): Promise<void>;
  consumeOAuthState(input: {
    stateHash: string;
    now: Date;
  }): Promise<{
    redirectUri: string;
    configurationBinding: SlackAppConfigurationBinding;
    oidcAuthorizationRequestId: string | null;
    delegatedDeliveryRequestId?: string | null;
    localAppAuthorizationId?: string | null;
  } | null>;
  upsertPrismUser(input: {
    identityScope: "workspace" | "organization";
    slackTeamId: string | null;
    slackUserId: string;
    slackEnterpriseId: string | null;
  }): Promise<{ id: string }>;
  upsertSlackConnection(input: {
    prismUserId: string;
    installationScope: "workspace" | "organization";
    isEnterpriseInstall: boolean;
    teamId: string | null;
    teamName: string | null;
    enterpriseId: string | null;
    enterpriseName: string | null;
    authedUserId: string;
    appId: string;
    botScopes: string;
    userScopes: string;
  }): Promise<{ id: string }>;
  upsertWorkspaceGrant(input: {
    connectionId: string;
    teamId: string;
    teamName: string | null;
    source: "oauth" | "legacy_backfill" | "auth_teams_list" | "event";
    verifiedAt: Date;
  }): Promise<void>;
  replaceOrganizationGrants(input: {
    connectionId: string;
    teams: SlackOrganizationWorkspace[];
    verifiedAt: Date;
  }): Promise<void>;
  saveSlackCredential(input: {
    connectionId: string;
    kind: "bot" | "user";
    tokenType: string | null;
    accessTokenEnvelope: CredentialEnvelope;
    refreshTokenEnvelope: CredentialEnvelope | null;
    expiresAt: Date | null;
    scopes: string | null;
  }): Promise<void>;
  createWebsiteSession(input: {
    sessionTokenHash: string;
    prismUserId: string;
    connectionId: string;
    expiresAt: Date;
  }): Promise<void>;
  finalizeSetupConfiguration(input: {
    configurationVersionId: string;
    setupSessionId: string;
    prismUserId: string;
    slackConnectionId: string;
    slackTeamId: string | null;
    slackUserId: string;
    requestId: string;
    now: Date;
  }): Promise<void>;
};

export type ResolvedSlackOAuthRuntime = {
  config: SlackOAuthConfig;
  slackOAuthClient: SlackOAuthClient;
};

export async function createSlackOAuthStart({
  store,
  config,
  configurationBinding,
  oidcAuthorizationRequestId = null,
  delegatedDeliveryRequestId = null,
  localAppAuthorizationId = null,
  now = new Date(),
  randomBytes = nodeRandomBytes
}: {
  store: OAuthFlowStore;
  config: SlackOAuthConfig;
  configurationBinding: SlackAppConfigurationBinding;
  oidcAuthorizationRequestId?: string | null;
  delegatedDeliveryRequestId?: string | null;
  localAppAuthorizationId?: string | null;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<{ state: string; stateHash: string; redirectUrl: string; cookie: CookieSpec }> {
  if ([oidcAuthorizationRequestId, delegatedDeliveryRequestId, localAppAuthorizationId].filter(Boolean).length > 1) {
    throw new Error("slack-oauth-continuation-conflict");
  }
  const state = randomBytes(32).toString("base64url");
  const stateHash = hashSecret(state);
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  await store.saveOAuthState({
    stateHash,
    redirectUri: config.redirectUri,
    configurationBinding,
    oidcAuthorizationRequestId,
    ...(delegatedDeliveryRequestId ? { delegatedDeliveryRequestId } : {}),
    ...(localAppAuthorizationId ? { localAppAuthorizationId } : {}),
    expiresAt
  });

  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("redirect_uri", config.redirectUri);
  authorize.searchParams.set("state", state);
  if (config.botScopes.length > 0) authorize.searchParams.set("scope", config.botScopes.join(","));
  if (config.userScopes.length > 0) authorize.searchParams.set("user_scope", config.userScopes.join(","));

  return {
    state,
    stateHash,
    redirectUrl: authorize.toString(),
    cookie: oauthStateCookie(state, config.publicBaseUrl)
  };
}

export async function completeSlackOAuthCallback({
  store,
  cipher,
  deployment,
  resolveRuntime,
  code,
  state,
  cookieState,
  oauthError = null,
  requestId,
  discoverOrganizationWorkspaces,
  now = new Date(),
  randomBytes = nodeRandomBytes
}: {
  store: OAuthFlowStore;
  cipher: CredentialCipher;
  deployment: Pick<SlackOAuthConfig, "redirectUri" | "publicBaseUrl">;
  resolveRuntime(binding: SlackAppConfigurationBinding): Promise<ResolvedSlackOAuthRuntime>;
  code: string | null;
  state: string | null;
  cookieState: string | null;
  oauthError?: string | null;
  requestId: string;
  discoverOrganizationWorkspaces?: (accessToken: string) => Promise<OrganizationWorkspaceDiscoveryResult>;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): Promise<
  | {
      kind: "linked";
      redirectUrl: string;
      sessionCookie: CookieSpec;
      oidcAuthorizationRequestId: string | null;
      delegatedDeliveryRequestId?: string | null;
      localAppAuthorizationId?: string | null;
      setupConfigurationActivated: boolean;
      installationScope: "workspace" | "organization";
      organizationGrantSync: "not_applicable" | "complete" | "unavailable";
      organizationGrantCount: number;
    }
  | {
      kind: "invalid_state" | "slack_error";
      redirectUrl: string;
      oidcAuthorizationRequestId?: string | null;
      delegatedDeliveryRequestId?: string | null;
      localAppAuthorizationId?: string | null;
      sessionCookie?: undefined;
      failureReason?: OAuthFailureReason;
    }
> {
  if (!state || !cookieState || !equalSecret(state, cookieState)) {
    return { kind: "invalid_state", redirectUrl: statusRedirect(deployment, "error") };
  }

  const storedState = await store.consumeOAuthState({ stateHash: hashSecret(state), now });
  if (!storedState || storedState.redirectUri !== deployment.redirectUri) {
    return { kind: "invalid_state", redirectUrl: statusRedirect(deployment, "error") };
  }

  const configurationBinding = storedState.configurationBinding;
  const setupBinding =
    configurationBinding.kind === "database" && configurationBinding.setupSessionId
      ? { ...configurationBinding, setupSessionId: configurationBinding.setupSessionId }
      : null;

  if (oauthError || !code) {
    return {
      kind: "slack_error",
      redirectUrl: statusRedirect(deployment, "error", setupBinding, undefined, "authorization_denied"),
      failureReason: "authorization_denied",
      oidcAuthorizationRequestId: storedState.oidcAuthorizationRequestId,
      ...(storedState.delegatedDeliveryRequestId ? { delegatedDeliveryRequestId: storedState.delegatedDeliveryRequestId } : {}),
      ...(storedState.localAppAuthorizationId ? { localAppAuthorizationId: storedState.localAppAuthorizationId } : {})
    };
  }

  let runtime: ResolvedSlackOAuthRuntime;
  try {
    runtime = await resolveRuntime(storedState.configurationBinding);
  } catch {
    return {
      kind: "slack_error",
      redirectUrl: statusRedirect(deployment, "error", setupBinding, undefined, "runtime_unavailable"),
      failureReason: "runtime_unavailable",
      oidcAuthorizationRequestId: storedState.oidcAuthorizationRequestId,
      ...(storedState.delegatedDeliveryRequestId ? { delegatedDeliveryRequestId: storedState.delegatedDeliveryRequestId } : {}),
      ...(storedState.localAppAuthorizationId ? { localAppAuthorizationId: storedState.localAppAuthorizationId } : {})
    };
  }
  if (
    runtime.config.redirectUri !== storedState.redirectUri ||
    runtime.config.redirectUri !== deployment.redirectUri ||
    runtime.config.publicBaseUrl !== deployment.publicBaseUrl
  ) {
    return {
      kind: "invalid_state",
      redirectUrl: statusRedirect(deployment, "error", setupBinding),
      ...(storedState.localAppAuthorizationId ? { localAppAuthorizationId: storedState.localAppAuthorizationId } : {})
    };
  }

  const slackResult = await runtime.slackOAuthClient.exchangeCode({
    code,
    redirectUri: runtime.config.redirectUri
  });
  if (!slackResult.ok) {
    return {
      kind: "slack_error",
      redirectUrl: statusRedirect(deployment, "error", setupBinding, undefined, "provider_rejected"),
      failureReason: "provider_rejected",
      oidcAuthorizationRequestId: storedState.oidcAuthorizationRequestId,
      ...(storedState.delegatedDeliveryRequestId ? { delegatedDeliveryRequestId: storedState.delegatedDeliveryRequestId } : {}),
      ...(storedState.localAppAuthorizationId ? { localAppAuthorizationId: storedState.localAppAuthorizationId } : {})
    };
  }

  if (
    !nonemptySlackIdentifier(slackResult.appId) ||
    (slackResult.installationScope === "workspace" && !nonemptySlackIdentifier(slackResult.team?.id ?? "")) ||
    (slackResult.installationScope === "organization" && !nonemptySlackIdentifier(slackResult.enterprise?.id ?? "")) ||
    !nonemptySlackIdentifier(slackResult.authedUser.id) ||
    (runtime.config.userScopes.length > 0 && !usableInstallationCredential(slackResult.authedUser, "user")) ||
    (runtime.config.botScopes.length > 0 && !usableInstallationCredential(slackResult.bot, "bot"))
  ) {
    return {
      kind: "slack_error",
      redirectUrl: statusRedirect(deployment, "error", setupBinding, undefined, "invalid_provider_response"),
      failureReason: "invalid_provider_response",
      oidcAuthorizationRequestId: storedState.oidcAuthorizationRequestId,
      ...(storedState.delegatedDeliveryRequestId ? { delegatedDeliveryRequestId: storedState.delegatedDeliveryRequestId } : {}),
      ...(storedState.localAppAuthorizationId ? { localAppAuthorizationId: storedState.localAppAuthorizationId } : {})
    };
  }

  const sessionToken = randomBytes(32).toString("base64url");
  let organizationWorkspaceDiscovery: OrganizationWorkspaceDiscoveryResult | null = null;
  if (slackResult.installationScope === "organization" && discoverOrganizationWorkspaces && slackResult.authedUser.accessToken) {
    try {
      organizationWorkspaceDiscovery = await discoverOrganizationWorkspaces(slackResult.authedUser.accessToken);
    } catch {
      organizationWorkspaceDiscovery = { kind: "provider_error", error: "slack_directory_unavailable" };
    }
  }
  try {
    await store.transaction(async (transactionStore) => {
      const prismUser = await transactionStore.upsertPrismUser({
        identityScope: slackResult.installationScope,
        slackTeamId: slackResult.team?.id ?? null,
        slackUserId: slackResult.authedUser.id,
        slackEnterpriseId: slackResult.enterprise?.id ?? null
      });
      const connection = await transactionStore.upsertSlackConnection({
        prismUserId: prismUser.id,
        installationScope: slackResult.installationScope,
        isEnterpriseInstall: slackResult.isEnterpriseInstall,
        teamId: slackResult.team?.id ?? null,
        teamName: slackResult.team?.name ?? null,
        enterpriseId: slackResult.enterprise?.id ?? null,
        enterpriseName: slackResult.enterprise?.name ?? null,
        authedUserId: slackResult.authedUser.id,
        appId: slackResult.appId,
        botScopes: slackResult.bot?.scope ?? "",
        userScopes: slackResult.authedUser.scope ?? ""
      });

      if (slackResult.team) {
        await transactionStore.upsertWorkspaceGrant({
          connectionId: connection.id,
          teamId: slackResult.team.id,
          teamName: slackResult.team.name ?? null,
          source: "oauth",
          verifiedAt: now
        });
      } else if (organizationWorkspaceDiscovery?.kind === "ok") {
        await transactionStore.replaceOrganizationGrants({
          connectionId: connection.id,
          teams: organizationWorkspaceDiscovery.teams,
          verifiedAt: now
        });
      }

      await storeCredentialIfPresent({
        store: transactionStore,
        cipher,
        connectionId: connection.id,
        kind: "bot",
        token: slackResult.bot,
        now
      });
      await storeCredentialIfPresent({
        store: transactionStore,
        cipher,
        connectionId: connection.id,
        kind: "user",
        token: slackResult.authedUser,
        now
      });

      if (setupBinding) {
        await transactionStore.finalizeSetupConfiguration({
          configurationVersionId: setupBinding.versionId,
          setupSessionId: setupBinding.setupSessionId,
          prismUserId: prismUser.id,
          slackConnectionId: connection.id,
          slackTeamId: slackResult.team?.id ?? null,
          slackUserId: slackResult.authedUser.id,
          requestId,
          now
        });
      }

      await transactionStore.createWebsiteSession({
        sessionTokenHash: hashSecret(sessionToken),
        prismUserId: prismUser.id,
        connectionId: connection.id,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      });
    });
  } catch {
    return {
      kind: "slack_error",
      redirectUrl: statusRedirect(deployment, "error", setupBinding, undefined, "persistence_failed"),
      failureReason: "persistence_failed",
      oidcAuthorizationRequestId: storedState.oidcAuthorizationRequestId,
      ...(storedState.delegatedDeliveryRequestId ? { delegatedDeliveryRequestId: storedState.delegatedDeliveryRequestId } : {}),
      ...(storedState.localAppAuthorizationId ? { localAppAuthorizationId: storedState.localAppAuthorizationId } : {})
    };
  }

  return {
    kind: "linked",
    redirectUrl: statusRedirect(deployment, "linked", setupBinding, {
      installationScope: slackResult.installationScope,
      organizationWorkspaceDiscovery
    }),
    sessionCookie: sessionCookie(sessionToken, deployment.publicBaseUrl),
    oidcAuthorizationRequestId: storedState.oidcAuthorizationRequestId,
    setupConfigurationActivated: Boolean(setupBinding),
    installationScope: slackResult.installationScope,
    organizationGrantSync: slackResult.installationScope !== "organization"
      ? "not_applicable"
      : organizationWorkspaceDiscovery?.kind === "ok" ? "complete" : "unavailable",
    organizationGrantCount: organizationWorkspaceDiscovery?.kind === "ok" ? organizationWorkspaceDiscovery.teams.length : 0,
    ...(storedState.delegatedDeliveryRequestId ? { delegatedDeliveryRequestId: storedState.delegatedDeliveryRequestId } : {}),
    ...(storedState.localAppAuthorizationId ? { localAppAuthorizationId: storedState.localAppAuthorizationId } : {})
  };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function equalSecret(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

function nonemptySlackIdentifier(value: string): boolean {
  return value.trim().length > 0 && value.length <= 255;
}

function usableInstallationCredential(
  token: SlackOAuthSuccess["bot"] | SlackOAuthSuccess["authedUser"] | undefined,
  expectedKind: "bot" | "user"
): boolean {
  if (!boundedCredentialValue(token?.accessToken)) return false;
  if (token?.tokenType && token.tokenType !== expectedKind) return false;
  if (token?.expiresIn === undefined) return token.refreshToken === undefined || boundedCredentialValue(token.refreshToken);
  return (
    Number.isSafeInteger(token.expiresIn) &&
    token.expiresIn > 0 &&
    token.expiresIn <= 31 * 24 * 60 * 60 &&
    boundedCredentialValue(token.refreshToken)
  );
}

function boundedCredentialValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}

function oauthStateCookie(value: string, publicBaseUrl: string): CookieSpec {
  return {
    name: slackOAuthStateCookieName,
    value,
    httpOnly: true,
    sameSite: "lax",
    secure: publicBaseUrl.startsWith("https://"),
    path: "/",
    maxAge: 10 * 60
  };
}

function sessionCookie(value: string, publicBaseUrl: string): CookieSpec {
  return {
    name: prismSessionCookieName,
    value,
    httpOnly: true,
    sameSite: "lax",
    secure: publicBaseUrl.startsWith("https://"),
    path: "/",
    maxAge: 30 * 24 * 60 * 60
  };
}

function statusRedirect(
  config: Pick<SlackOAuthConfig, "publicBaseUrl">,
  status: "linked" | "error",
  setupBinding: Extract<SlackAppConfigurationBinding, { kind: "database" }> | null = null,
  linkedResult?: {
    installationScope: "workspace" | "organization";
    organizationWorkspaceDiscovery: OrganizationWorkspaceDiscoveryResult | null;
  },
  failureReason?: OAuthFailureReason
): string {
  const url = new URL(config.publicBaseUrl);
  url.pathname = setupBinding ? "/setup" : "/";
  url.search = "";
  if (setupBinding) {
    url.searchParams.set(status === "linked" ? "status" : "error", status === "linked" ? "complete" : "verification_failed");
  } else {
    url.searchParams.set("slack", status);
    if (status === "error" && failureReason) url.searchParams.set("reason", failureReason);
    if (status === "linked" && linkedResult?.installationScope === "organization") {
      url.searchParams.set("installation", "organization");
      if (linkedResult.organizationWorkspaceDiscovery?.kind === "ok") {
        url.searchParams.set("grants", String(linkedResult.organizationWorkspaceDiscovery.teams.length));
      } else {
        url.searchParams.set("grant_sync", "unavailable");
      }
    }
  }
  return url.toString();
}

type OAuthFailureReason =
  | "authorization_denied"
  | "runtime_unavailable"
  | "provider_rejected"
  | "invalid_provider_response"
  | "persistence_failed";

async function storeCredentialIfPresent({
  store,
  cipher,
  connectionId,
  kind,
  token,
  now
}: {
  store: OAuthFlowStore;
  cipher: CredentialCipher;
  connectionId: string;
  kind: "bot" | "user";
  token?: SlackOAuthSuccess["bot"] | SlackOAuthSuccess["authedUser"];
  now: Date;
}): Promise<void> {
  if (!token?.accessToken) return;
  const aad = `slack-connection:${connectionId}:${kind}`;
  await store.saveSlackCredential({
    connectionId,
    kind,
    tokenType: token.tokenType ?? null,
    accessTokenEnvelope: await cipher.encrypt(token.accessToken, `${aad}:access`),
    refreshTokenEnvelope: token.refreshToken ? await cipher.encrypt(token.refreshToken, `${aad}:refresh`) : null,
    expiresAt: token.expiresIn ? new Date(now.getTime() + token.expiresIn * 1000) : null,
    scopes: token.scope ?? null
  });
}
