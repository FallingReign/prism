import "server-only";

export type AdminScope = { kind: "global" } | { kind: "enterprise"; enterpriseId: string } | { kind: "team"; teamId: string };

export type AdminAllowlistEntry = {
  slackUserId: string;
  scope: AdminScope;
};

export type AdminAllowlist = {
  entries: AdminAllowlistEntry[];
};

export type AdminSessionIdentity = {
  prismUserId: string;
  slackUserId: string;
  slackUserDisplayName: string | null;
  teamId: string | null;
  teamName: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
};

export type AdminIdentityStore = {
  getCurrentIdentity(input: { sessionToken: string; now: Date }): Promise<AdminSessionIdentity | null>;
};

export type AdminAuthorizationDecision =
  | ({ kind: "authorized"; scope: AdminScope } & AdminSessionIdentity)
  | { kind: "unauthenticated" }
  | { kind: "not_admin"; reason: "no_matching_entry" | "scope_mismatch" };

export async function resolvePrismAdmin({
  store,
  allowlist,
  sessionToken,
  now = new Date()
}: {
  store: AdminIdentityStore;
  allowlist: AdminAllowlist;
  sessionToken: string | undefined;
  now?: Date;
}): Promise<AdminAuthorizationDecision> {
  if (!sessionToken) return { kind: "unauthenticated" };

  const identity = await store.getCurrentIdentity({ sessionToken, now });
  if (!identity) return { kind: "unauthenticated" };

  const entriesForUser = allowlist.entries.filter((entry) => entry.slackUserId === identity.slackUserId);
  const matchingEntry = entriesForUser
    .filter((entry) => scopeMatches(entry.scope, identity))
    .sort((left, right) => scopeRank(right.scope) - scopeRank(left.scope))[0];
  if (!matchingEntry) return { kind: "not_admin", reason: entriesForUser.length > 0 ? "scope_mismatch" : "no_matching_entry" };

  return { kind: "authorized", ...identity, scope: matchingEntry.scope };
}

function scopeMatches(scope: AdminScope, identity: AdminSessionIdentity): boolean {
  if (scope.kind === "global") return true;
  if (scope.kind === "enterprise") return identity.enterpriseId === scope.enterpriseId;
  return identity.teamId === scope.teamId;
}

function scopeRank(scope: AdminScope): number {
  if (scope.kind === "global") return 3;
  if (scope.kind === "enterprise") return 2;
  return 1;
}
