# Prism persisted global administrator architecture integration

## Slice and stable intent

The initial successful Prism setup claimant must become a persisted **global Prism administrator**, not merely a Slack-configuration administrator. Persisted database grants are the normal authorization source. The JSON allowlist remains compatibility and break-glass recovery only. Existing global administrators may grant or revoke the persisted role from the Prism Users UI, but a mutation must never demote its actor or leave Prism without an active persisted global administrator.

This slice does not merge Prism with Playtest, change Slack or OIDC identity semantics, introduce scoped database roles, or alter token-profile/delegated-delivery policy.

## Current ownership and runtime interaction

### Identity and authorization

- `src/server/admin/authorization.ts` owns the server-side `resolvePrismAdmin` decision and scope semantics. Today it resolves a website session through `AdminIdentityStore`, then authorizes only against the legacy Slack-user JSON allowlist.
- `src/server/admin/postgres-store.ts` owns session-to-canonical-Prism/Slack identity resolution. The website session is hashed, expiry-checked, joined to the current Prism user and latest Slack connection, and must remain the only source of actor identity.
- `src/server/admin/allowlist.ts` loads the legacy recovery/compatibility allowlist. Its Slack IDs and scoped entries must not become the database grant key; persisted grants bind to canonical `prism_user_id`.
- All admin pages and APIs call `resolvePrismAdmin`, except `app/admin/configuration/page.tsx`, which already checks `prism_configuration_admins` directly before falling back to the allowlist. This is evidence that setup already persists a claimant, but the grant is not part of the common authorization path.

### Setup claim

- `src/server/setup/bootstrap-postgres-store.ts` owns atomic setup capability/session consumption and `claimSessionAndConfigurationAdmin` under a PostgreSQL advisory lock.
- `src/server/slack/postgres-store.ts#finalizeSetupConfiguration` activates the Slack configuration, invokes that claim inside the OAuth transaction, and writes `configuration_admin_claimed` metadata audit.
- Migration `0017_prism_slack_app_configuration.sql` owns `prism_configuration_admins`. It currently permits only role `global_configuration_admin` and claim source `initial_bootstrap`, and has `created_at`/`revoked_at`. A successful initial setup claimant is therefore already persisted as the right canonical user, but only configuration code consumes it.
- Recovery setup currently revokes active configuration-admin rows before inserting the recovery claimant. The global-admin invariant must be preserved atomically if this table becomes the authorization source.

### User directory and actions

- `src/server/admin/postgres-user-directory-store.ts` owns database projection of Prism users; `src/server/admin/user-directory.ts` owns redaction and authorization-aware presentation.
- `app/admin/users/admin-users.tsx` owns directory/detail rendering. The detail view is the smallest established place for a global-admin status/control, alongside existing token-profile and Slack-connection admin actions.
- Existing mutations under `app/v1/prism/admin/users/[userId]/...` demonstrate the route contract: `rejectCrossOriginBrowserMutation`, session-cookie authorization, canonical target lookup, no-store JSON, request ID, transactional mutation plus required metadata-only audit, and explicit error mapping.
- Existing action components such as `admin-slack-connection-actions.tsx` demonstrate inline confirmation/error/retry UI. Admin grant/revoke should follow this interaction model without accepting actor identity from the browser.

### Audit

- `src/server/audit/activity.ts` and `src/server/audit/postgres-store.ts` own the metadata-only audit schema and insertion behavior.
- Migration constraints enumerate allowed activity types. Adding grant/revoke requires both TypeScript union changes and a new additive migration replacing the activity-type check.
- Grant/revoke audit records must contain target Prism user ID as object metadata, server-derived actor Prism/Slack identity, a bounded admin reason, request ID, outcome, and no tokens/content.

## Required extension points

1. **Persisted authorization lookup**
   - Extend `AdminIdentityStore` (or compose a separate `AdminGrantStore`) with a lookup keyed by canonical `prism_user_id`.
   - `resolvePrismAdmin` resolves the valid session identity once, then checks an active persisted `global_configuration_admin` grant first.
   - An active persisted row yields `{ kind: "authorized", scope: { kind: "global" } }`.
   - Only if no active persisted grant exists should the legacy allowlist be evaluated. Allowlist loading failures must not deny a valid persisted administrator; callers should no longer be forced to load the file before making the database decision.

2. **Grant model migration**
   - Reuse `prism_configuration_admins` rather than creating a parallel authority table; its existing role already names a global administrator and setup already writes it.
   - Add grant provenance suitable for UI/admin changes: allow `claim_source` values `initial_bootstrap`, `setup_recovery`, and `admin_grant` (or preserve recovery as initial bootstrap if migration risk outweighs value), plus optional `granted_by_prism_user_id`, `revoked_by_prism_user_id`, and bounded grant/revoke reason fields if audit alone is insufficient for current-state explanation.
   - Prefer current-state columns plus immutable audit for history; do not store Slack IDs as authorization keys.
   - Add an active-admin index/count path. PostgreSQL transactions plus a shared advisory lock must serialize setup claim, admin grant, and admin revoke.

3. **Setup persistence**
   - Keep `claimSessionAndConfigurationAdmin` as the setup write seam. Its existing transaction and lock must establish the persisted active global grant before setup completes.
   - Recovery must not create a transient zero-admin state visible outside the transaction. Revoke old and grant claimant in the same transaction/lock.
   - The existing `configuration_admin_claimed` event may remain for compatibility, but add/rename a global-admin grant event only if migration and presentation are updated consistently. Do not duplicate audit events for one setup claim.

4. **Admin grant service**
   - Add a server-only service/store under `src/server/admin/` with `grantGlobalAdmin` and `revokeGlobalAdmin`.
   - Service requires an authorized **global** decision, canonical target ID, bounded reason, request metadata, and current time.
   - Store transaction acquires one global-admin advisory lock, locks actor/target/current active grants, verifies target user exists, and performs an idempotent grant or guarded revoke.
   - Grant is idempotent (`already_admin` is a safe response, not a duplicate audit/write).
   - Revoke rejects actor == target (`self_demotion_forbidden`) and rejects when active persisted count would fall below one (`last_admin_forbidden`). Both checks must be repeated under the lock inside the mutation transaction, not only in UI/service code.
   - A legacy-allowlist recovery actor may grant the first persisted admin when none exists. Once persisted admins exist, the allowlist remains recovery-compatible but does not override revoke invariants.
   - Mutation and its audit record are one transaction; audit failure rolls back the grant/revoke.

5. **API and UI**
   - Add a focused route such as `PUT`/`DELETE /v1/prism/admin/users/[userId]/global-admin` or one `PATCH` route with an enum action. Separate `PUT` and `DELETE` gives clearer idempotency and route tests.
   - Both mutations call `rejectCrossOriginBrowserMutation` before reading the body; require the Prism HttpOnly session cookie; resolve the actor server-side; parse only reason/confirmation; return no-store JSON with request ID.
   - Directory/detail projection adds `globalAdmin: { active: boolean, source: ... }`. It must not expose credential material.
   - Only global admins see controls. The current actor’s revoke control is disabled with explicit “You cannot remove your own administrator access.” The sole-active-admin control is also disabled when reliably known; the API remains authoritative against races.
   - On success, the client refreshes only the affected server-rendered data (`router.refresh`) and shows an inline result; no full browser reload.

## Do-not-bypass systems and invariants

- Do not authorize by request body, Slack display name, Slack user ID alone, Playtest role, or browser-stored token. Actor identity comes only from the valid Prism session and canonical DB identity.
- Do not replace or weaken `resolvePrismAdmin`; converge all pages/routes, including configuration, on the common persisted-first resolver.
- Do not let absence/breakage of the legacy JSON file make persisted administration unavailable.
- Do not perform grant/revoke outside a transaction or without the shared advisory lock and `FOR UPDATE` checks.
- Do not permit self-demotion or removal of the last active persisted global admin, even if the caller is allowlisted.
- Do not let UI disabled state be the only enforcement.
- Do not write tokens, Slack message content, configuration secrets, or free-form unbounded text to audit.
- Do not broaden scoped allowlist admins into global database admins. Only a global persisted/legacy admin may mutate global grants.
- Do not change OIDC, delegated-delivery, Playtest app-token, or Slack credential custody behavior in this slice.

## Integration sequence

1. Add focused failing authorization tests: persisted grant wins; absent grant falls back to allowlist; allowlist loader unavailable is irrelevant for persisted admin; revoked grant falls back/denies; scoped allowlist behavior unchanged.
2. Add the additive migration for grant provenance/indexes and admin-grant/revoke audit activity types.
3. Extend the Postgres identity/grant lookup and update `resolvePrismAdmin` to persisted-first behavior. Introduce one helper that callers use so they do not eagerly fail on `loadAdminAllowlist`.
4. Update setup claim tests to prove the claimant receives the active global grant and recovery preserves at least one active grant atomically.
5. Add the transactional grant/revoke service/store with concurrency and invariant tests.
6. Add the same-origin protected route and focused route tests for unauthorized, non-global, cross-origin, self, last-admin, not-found, audit-unavailable, idempotent, and success paths.
7. Extend directory/detail projection and Users UI with status and guarded controls; add render/interaction tests.
8. Replace configuration’s bespoke DB check with the common resolver; update all admin callers to the lazy fallback contract.
9. Run focused admin/setup/audit tests, migration smoke test against a disposable database if available, then a live local setup/login/admin grant/revoke QA pass.

## Regression checklist

- Existing initial setup and explicit recovery remain one-time, atomic, and auditable.
- Existing persisted claimant can access `/admin`, `/admin/users`, global policy, and configuration without a JSON entry.
- Existing legacy global/team/enterprise allowlist entries retain their prior scope when no persisted grant applies.
- A database-granted global admin is not narrowed by a conflicting scoped allowlist entry.
- A revoked persisted grant does not authorize unless an independent legacy recovery entry still does; UI should explain recovery-source access if exposed.
- Invalid/expired sessions remain unauthenticated.
- Admin pages and APIs remain `no-store`; mutations remain same-origin protected.
- Concurrent revoke/revoke and recovery/revoke cannot produce zero active persisted admins.
- Grant/revoke audit is metadata-only and atomic with state change.
- User directory still includes disconnected retained users and redacts secret-shaped text.
- Existing token-profile, Slack-connection, global-policy, OIDC, and delegated-delivery tests do not regress.

## Focused test plan

- `src/server/admin/authorization.test.ts`: persisted-first and fallback matrix, including allowlist failure handling at the caller/helper boundary.
- `src/server/admin/postgres-store.test.ts`: session identity plus active/revoked grant resolution.
- New `src/server/admin/global-admin-actions.test.ts`: authorization, validation, idempotency, self/last guard, advisory lock, transactional audit, concurrent behavior.
- `src/server/setup/bootstrap-postgres-store.test.ts`: setup and recovery claimant active-global invariant.
- `src/server/admin/postgres-user-directory-store.test.ts` and `user-directory.test.ts`: role projection/redaction.
- New route tests under `app/v1/prism/admin/users/[userId]/global-admin/`: CSRF, session, global scope, error mapping, request IDs/no-store.
- `app/admin/users/admin-users.test.tsx` plus client action tests: visible status, current-user disabled revoke, last-admin explanation, successful async refresh.
- Existing admin page/session/policy/configuration tests to confirm all surfaces use the common resolver.
- Migration constraint test or disposable-Postgres smoke test for audit enum, source enum, unique/current behavior, and existing 0017 rows.

## Risks and mitigations

- **Lockout during migration:** existing `prism_configuration_admins` rows are retained and become authoritative immediately; JSON global allowlist remains fallback/recovery.
- **Eager allowlist failure:** many current callers load the allowlist before `resolvePrismAdmin`. Introduce a common resolver/fallback loader so persisted authorization does not depend on file availability, then migrate every caller in the same slice.
- **Race to zero admins:** serialize all setup/admin mutations with one advisory lock and repeat count/self checks inside the transaction.
- **Privilege expansion:** only the setup claimant’s already-persisted `global_configuration_admin` becomes globally effective. Scoped allowlist entries remain scoped and cannot grant database roles.
- **Stale UI:** API enforces invariants and returns explicit conflict codes; UI refreshes state after every action.
- **Audit constraint drift:** update TypeScript and database enum constraints in the same additive migration and include rollback-on-audit-failure tests.
- **Shared dirty worktree:** modify and stage only admin/setup/audit/user-directory files and isolated migration/route/UI files; do not include OIDC, first-party app-token, Slack display-name, or delegated-delivery changes.

## Decision confidence

**High (0.90).** The database already persists the correct canonical setup claimant and role, configuration already treats that row as an authorization source, and the repository has established patterns for same-origin admin mutations, transactional metadata audit, and scoped directory UI. The main integration risk is mechanical breadth: all existing admin callers must stop eagerly depending on the JSON allowlist so persisted administrators remain available when the recovery file is absent.
