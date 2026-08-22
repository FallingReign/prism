import "server-only";

import type { CredentialEnvelope } from "../credentials/encryption";

export const SLACK_SCOPE_CATALOG = [
  scope("channels:read", "bot", "conversations", "Read public-channel metadata", "read"),
  scope("channels:history", "bot", "conversations", "Read public-channel history", "read"),
  scope("groups:read", "bot", "conversations", "Read private-channel metadata", "read"),
  scope("groups:history", "bot", "conversations", "Read private-channel history", "read"),
  scope("im:read", "bot", "conversations", "Read direct-message metadata", "read"),
  scope("im:history", "bot", "conversations", "Read direct-message history", "read"),
  scope("mpim:read", "bot", "conversations", "Read group-message metadata", "read"),
  scope("mpim:history", "bot", "conversations", "Read group-message history", "read"),
  scope("chat:write", "bot", "messages", "Send messages as the app", "write"),
  scope("reactions:read", "bot", "reactions", "Read reactions", "read"),
  scope("reactions:write", "bot", "reactions", "Add and remove reactions", "write"),
  scope("files:read", "bot", "files", "Read files shared with the app", "read"),
  scope("users:read", "bot", "directory", "Read workspace member profiles", "read"),
  scope("channels:read", "user", "conversations", "Read public-channel metadata as the user", "read"),
  scope("channels:history", "user", "conversations", "Read public-channel history as the user", "read"),
  scope("groups:read", "user", "conversations", "Read private-channel metadata as the user", "read"),
  scope("groups:history", "user", "conversations", "Read private-channel history as the user", "read"),
  scope("im:read", "user", "conversations", "Read direct-message metadata as the user", "read"),
  scope("im:history", "user", "conversations", "Read direct-message history as the user", "read"),
  scope("mpim:read", "user", "conversations", "Read group-message metadata as the user", "read"),
  scope("mpim:history", "user", "conversations", "Read group-message history as the user", "read"),
  scope("chat:write", "user", "messages", "Send Playtest announcements as the signed-in user", "write", true, true),
  scope("reactions:read", "user", "reactions", "Read reactions as the user", "read"),
  scope("reactions:write", "user", "reactions", "Add and remove reactions as the user", "write"),
  scope("files:read", "user", "files", "Read files available to the user", "read"),
  scope("users:read", "user", "directory", "Read workspace member profiles as the user", "read"),
  scope("search:read", "user", "search", "Search content available to the user", "read")
] as const;

export type SlackScopeCatalogEntry = (typeof SLACK_SCOPE_CATALOG)[number];
export type SlackScopeId = SlackScopeCatalogEntry["id"];
export type SlackScopeKind = SlackScopeCatalogEntry["tokenKind"];
export type SlackScopeSelection = {
  botScopes: SlackScopeId[];
  userScopes: SlackScopeId[];
};

const BOT_SCOPE_IDS = scopeIds("bot");
const USER_SCOPE_IDS = scopeIds("user");

export const DEFAULT_SLACK_SCOPE_SELECTION: Readonly<SlackScopeSelection> = Object.freeze({
  botScopes: Object.freeze([...BOT_SCOPE_IDS]) as SlackScopeId[],
  userScopes: Object.freeze([...USER_SCOPE_IDS]) as SlackScopeId[]
});

export const ALL_PRISM_SUPPORTED_SLACK_SCOPES: Readonly<SlackScopeSelection> = Object.freeze({
  botScopes: Object.freeze([...BOT_SCOPE_IDS]) as SlackScopeId[],
  userScopes: Object.freeze([...USER_SCOPE_IDS]) as SlackScopeId[]
});

export type SlackAppConfigurationStatus = "pending" | "active" | "superseded";
export type SlackAppConfigurationCreatedVia = "bootstrap" | "configuration_admin";

export type ValidatedSlackAppConfigurationInput = {
  clientId: string;
  clientSecret: string;
  botScopes: SlackScopeId[];
  userScopes: SlackScopeId[];
};

export type StoredSlackAppConfigurationVersion = {
  id: string;
  version: string;
  status: SlackAppConfigurationStatus;
  clientId: string;
  clientSecretEnvelope: CredentialEnvelope;
  botScopes: SlackScopeId[];
  userScopes: SlackScopeId[];
  createdVia: SlackAppConfigurationCreatedVia;
  createdByPrismUserId: string | null;
  setupSessionId: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  supersededAt: Date | null;
};

export type RedactedSlackAppConfiguration = Omit<
  StoredSlackAppConfigurationVersion,
  "clientSecretEnvelope"
> & {
  secretConfigured: true;
};

export type SlackAppConfigurationBinding =
  | { kind: "environment"; fingerprint: string }
  | { kind: "database"; versionId: string; setupSessionId: string | null };

export type SlackAppConfigurationRevision =
  | { kind: "environment"; fingerprint: string }
  | { kind: "database"; versionId: string; version: string };

export class SlackAppConfigurationValidationError extends Error {
  readonly code:
    | "invalid-client-id"
    | "invalid-client-secret"
    | "invalid-bot-scopes"
    | "invalid-user-scopes"
    | "required-user-scope-missing";

  constructor(code: SlackAppConfigurationValidationError["code"]) {
    super(`slack-app-configuration-invalid:${code}`);
    this.name = "SlackAppConfigurationValidationError";
    this.code = code;
  }
}

export function selectAllPrismSupportedSlackScopes(): SlackScopeSelection {
  return {
    botScopes: [...ALL_PRISM_SUPPORTED_SLACK_SCOPES.botScopes],
    userScopes: [...ALL_PRISM_SUPPORTED_SLACK_SCOPES.userScopes]
  };
}

export function canonicalizeSlackScopeSelection(
  input: {
    botScopes?: readonly string[] | null;
    userScopes?: readonly string[] | null;
  } = {}
): SlackScopeSelection {
  const explicitlySelected = input.botScopes !== undefined || input.userScopes !== undefined;
  const botScopes = canonicalizeKind(
    "bot",
    explicitlySelected ? input.botScopes ?? [] : DEFAULT_SLACK_SCOPE_SELECTION.botScopes
  );
  const userScopes = canonicalizeKind(
    "user",
    explicitlySelected ? input.userScopes ?? [] : DEFAULT_SLACK_SCOPE_SELECTION.userScopes
  );
  if (!userScopes.includes("chat:write")) {
    throw new SlackAppConfigurationValidationError("required-user-scope-missing");
  }
  return { botScopes, userScopes };
}

export function validateSlackAppConfigurationInput(
  input: {
    clientId: unknown;
    clientSecret: unknown;
    botScopes?: readonly string[] | null;
    userScopes?: readonly string[] | null;
  },
  options: { production?: boolean } = {}
): ValidatedSlackAppConfigurationInput {
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  if (
    clientId.length < 1 ||
    clientId.length > 255 ||
    /[\u0000-\u001f\u007f\\]/.test(clientId) ||
    clientId.includes("replace-with") ||
    (options.production === true && clientId === "mock-playtest-client")
  ) {
    throw new SlackAppConfigurationValidationError("invalid-client-id");
  }

  const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret : "";
  const clientSecretBytes = Buffer.byteLength(clientSecret, "utf8");
  if (
    clientSecretBytes < 1 ||
    clientSecretBytes > 4096 ||
    clientSecret.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/.test(clientSecret)
  ) {
    throw new SlackAppConfigurationValidationError("invalid-client-secret");
  }

  return {
    clientId,
    clientSecret,
    ...canonicalizeSlackScopeSelection({
      ...(input.botScopes !== undefined ? { botScopes: input.botScopes } : {}),
      ...(input.userScopes !== undefined ? { userScopes: input.userScopes } : {})
    })
  };
}

export function redactSlackAppConfiguration(
  configuration:
    | StoredSlackAppConfigurationVersion
    | (Omit<StoredSlackAppConfigurationVersion, "clientSecretEnvelope"> & { secretConfigured: true })
): RedactedSlackAppConfiguration {
  const {
    id,
    version,
    status,
    clientId,
    botScopes,
    userScopes,
    createdVia,
    createdByPrismUserId,
    setupSessionId,
    createdAt,
    activatedAt,
    supersededAt
  } = configuration;
  return {
    id,
    version,
    status,
    clientId,
    botScopes: [...botScopes],
    userScopes: [...userScopes],
    createdVia,
    createdByPrismUserId,
    setupSessionId,
    createdAt,
    activatedAt,
    supersededAt,
    secretConfigured: true
  };
}

function scope<
  Id extends string,
  Kind extends "bot" | "user",
  Family extends "conversations" | "messages" | "reactions" | "files" | "directory" | "search"
>(
  id: Id,
  tokenKind: Kind,
  productFamily: Family,
  help: string,
  risk: "read" | "write",
  required = false,
  defaultSelected = true
) {
  return { id, tokenKind, productFamily, help, risk, required, defaultSelected } as const;
}

function scopeIds(kind: SlackScopeKind): SlackScopeId[] {
  return SLACK_SCOPE_CATALOG.filter((entry) => entry.tokenKind === kind).map((entry) => entry.id);
}

function canonicalizeKind(kind: SlackScopeKind, selected: readonly string[]): SlackScopeId[] {
  if (!Array.isArray(selected)) {
    throw new SlackAppConfigurationValidationError(kind === "bot" ? "invalid-bot-scopes" : "invalid-user-scopes");
  }
  const allowed = kind === "bot" ? BOT_SCOPE_IDS : USER_SCOPE_IDS;
  const allowedSet = new Set<string>(allowed);
  if (selected.some((candidate) => typeof candidate !== "string" || !allowedSet.has(candidate))) {
    throw new SlackAppConfigurationValidationError(kind === "bot" ? "invalid-bot-scopes" : "invalid-user-scopes");
  }
  const selectedSet = new Set(selected);
  return allowed.filter((scopeId) => selectedSet.has(scopeId));
}
