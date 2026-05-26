# Architecture Integration Brief: inactive-profile-retention-delete

## Existing ownership

- Package/component/module/library:
  - `app/page.tsx` owns homepage server composition: session-cookie lookup, Slack website status, Token profile summaries, and recent metadata audit (`app/page.tsx:23-29`, `135-147`).
  - `app/token-profiles-panel.tsx` owns the homepage Token profile client island: create modal, profile list rendering, copy-once developer-token display, Remove access confirmation, local mutation state, and fetch calls to lifecycle APIs (`app/token-profiles-panel.tsx:24-76`, `80-246`).
  - `app/token-profile-detail-panel.tsx` and `app/token-profiles/[profileId]/page.tsx` own retained profile inspection: lifecycle/policy/detail UI, profile-specific audit rendering, direct route lookup, and route-refresh after mutations (`app/token-profile-detail-panel.tsx:50-127`, `129-274`; `app/token-profiles/[profileId]/page.tsx:20-52`, `76-80`).
  - `src/server/token-profiles/service.ts` owns public Token profile lifecycle semantics, validation, copy-once token issuance, revoke/rotate/policy orchestration, and owner resolution (`service.ts:103-292`).
  - `src/server/token-profiles/store.ts` owns Postgres persistence and lifecycle transactions for profile rows and `prism_developer_tokens` (`store.ts:31-39`, `40-159`, `160-309`).
  - `src/server/audit/postgres-store.ts` owns metadata-only audit persistence, retention filtering, and session/profile-scoped audit reads (`postgres-store.ts:13-31`, `47-100`, `103-157`).
  - `components/ui/dialog.tsx`, shadcn-style local primitives, `app/ui.tsx`, and Radix own modal/focus UI substrate (`components/ui/dialog.tsx:1-82`).
- Current owner rationale:
  - Inactive profile retention is currently split: persistence retains rows because revoke only updates developer tokens, while UI hides revoked-token profiles through `activeTokenProfiles`.
  - Permanent profile deletion is not owned today. There is no DELETE route, no service method, no store method, and no UI action for hard deletion.
  - The correct owner for permanent deletion is the existing route/service/store lifecycle path, with UI only initiating/confirming and rendering server-returned metadata.
- Source evidence:
  - Current `TokenProfileStore` has list/insert/revoke/rotate/update methods but no delete method (`service.ts:57-101`).
  - `revokeProfileDeveloperTokens` selects `p.status = 'active'`, revokes `prism_developer_tokens`, writes `token_profile_revoked`, and returns profile metadata without updating `token_profiles.status` (`store.ts:110-158`).
  - `listProfiles` filters `p.status = 'active'` (`store.ts:31-39`), while the DB status check permits `active`, `bootstrap`, and `revoked` (`db/migrations/0002_prism_developer_tokens.sql:69-77`).
  - Existing audit schema preserves audit rows if a Token profile row is deleted because `token_profile_id` references `token_profiles(id) ON DELETE SET NULL` and stores `token_profile_name` separately (`db/migrations/0003_prism_activity_audit.sql:1-10`).

## Existing interaction model

- User/system behaviors that already exist:
  - Linked users see Token profile management on the homepage; unlinked users see a connect Slack state; `reauth_required` keeps profile management visible while warning that Slack calls are unavailable (`app/page.tsx:90-114`, `app/token-profiles-panel.tsx:87-91`).
  - Create returns a Prism developer token once and immediately clears prior token/error state before submission (`app/token-profiles-panel.tsx:41-61`, `117-132`).
  - Rotate and policy broadening return replacement Prism developer tokens once; policy narrowing does not require rotation (`app/token-profile-detail-panel.tsx:69-110`; `service.ts:234-292`).
  - Remove access currently calls POST `/v1/prism/token-profiles/:id/revoke`, revokes developer tokens, returns no token material, and preserves metadata/audit (`app/token-profiles-panel.tsx:63-76`; `app/v1/prism/token-profiles/[profileId]/revoke/route.ts:15-28`).
  - Detail routes already load profile metadata and profile-specific audit by direct URL using server-side store calls, not internal HTTP (`app/token-profiles/[profileId]/page.tsx:20-52`).
  - Audit UI is metadata-only and intentionally excludes Slack payloads, OAuth material, developer tokens, token hashes, peppers, and content (`src/server/audit/postgres-store.test.ts:12-71`, `126-180`).
- Behaviors that must remain unchanged:
  - Plaintext Prism developer tokens are copy-once only for create/rotate/confirmed broadening responses and must never appear in list/detail/audit/delete/revoke responses or logs.
  - Slack OAuth credentials, token hashes, pepper material, Slack payload/content, and request bodies must stay out of UI, API JSON, audit rows, tests, and logs.
  - Revoke/Remove access must invalidate current developer-token use and must not delete metadata/audit.
  - Direct detail inspection for removed/revoked profiles must remain available until permanent deletion.
  - Audit retention remains time-based through `retention_expires_at`; profile deletion must not manually purge audit rows earlier than retention.
- Runtime or UX evidence:
  - Targeted baseline passed during scout: `npm test -- --run app/token-profiles-panel.test.tsx app/token-profile-detail-panel.test.tsx app/token-profile-workspace.test.ts src/server/token-profiles/service.test.ts src/server/token-profiles/store.test.ts src/server/audit/postgres-store.test.ts --reporter=dot` => 6 files, 18 tests passed.
  - Current tests encode the old behavior: `app/token-profiles-panel.test.tsx:56-79` expects revoked Token profiles to be hidden from the homepage. This conflicts with the new product decision.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep initial homepage and detail reads server-side through `cookies()`, `database`, `createPostgresTokenProfileStore`, `listTokenProfiles`, `createPostgresActivityAuditStore`, and presentation mappers (`app/page.tsx:23-29`, `135-147`; detail page `20-52`).
  - Keep browser mutations on route handlers with `Cache-Control: no-store` and `X-Prism-Request-ID` response headers (`app/v1/prism/token-profiles/route.ts:100-105`; revoke route `35-40`; rotate route `55-60`; policy route `88-93`).
  - Reuse `TokenProfileSummary` and add profile lifecycle status there instead of inventing a second client model (`app/token-profile-summary.ts:3-19`).
  - Extend `TokenProfileStore`/service for deletion and status-aware listing; do not put deletion SQL in route handlers or components.
  - Use `token_profiles.status` for profile lifecycle state and `prism_developer_tokens.revoked_at/is_current` for developer-token usability; they are separate but related state machines.
  - Use existing Radix-backed `Dialog` for both Remove access and permanent delete confirmation. There is no local `AlertDialog` wrapper today; do not hand-roll focus trapping.
- Relevant docs or library capabilities:
  - Next App Router supports sibling `app/v1/prism/token-profiles/[profileId]/route.ts` for DELETE alongside nested `revoke`, `rotate`, and `policy` route folders.
  - Radix Dialog already provides accessible modal behavior through the local wrapper.
  - Postgres FK behavior already supports deletion retention: developer token rows cascade with the profile, while audit rows survive with `token_profile_id = null` and denormalized `token_profile_name`.
- Existing examples in this codebase:
  - Lifecycle routes consistently parse inputs in route handlers, delegate to service, and use service/store for auth and persistence (`route.ts`, revoke/rotate/policy routes).
  - Store/service tests use fake stores/databases to assert no secret leakage and exact SQL behavior.
  - `listRecentActivityForTokenProfile` already scopes by current session user, profile id, retention, and bounded limit (`postgres-store.ts:77-99`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate Token profile lifecycle SQL in React components or route handlers; extend `TokenProfileStore` and service.
  - Do not add a parallel inactive-profile table, client cache, local storage retention layer, server action path, or alternate auth/session resolver.
  - Do not bypass existing route response conventions (`no-store`, request id, JSON error shapes) or existing audit insertion helpers.
  - Do not replace Radix/shadcn Dialog with custom modal/focus code.
  - Do not alter Slack OAuth custody, Slack credential storage, local-tool token resolution, method policy, rate limits, or Slack forwarding behavior except where profile status naturally affects token usability.
- Shortcuts or parallel paths to avoid:
  - Do not keep hiding revoked profiles through a homepage-only `activeTokenProfiles` filter; that is the old behavior and now conflicts with product intent.
  - Do not implement permanent delete as another call to `/revoke`; revoke and hard delete are different lifecycle events.
  - Do not mark profiles permanently deleted only in client state; deletion must be durable and authorization-checked server-side.
  - Do not delete audit rows manually when deleting a profile; let retention and FK rules preserve metadata-only audit.
  - Do not allow DELETE for active profiles or for profiles with a usable current developer token.
- Invariants:
  - Active means profile row is active and current developer token is usable, subject to Slack reauth.
  - Inactive/removed means no usable Prism developer token and retained profile/audit metadata.
  - Deleted means no Token profile row and no retrievable detail page; retained global audit may still show metadata-only historic events until audit retention expires.
  - Copy-once token material remains visible only immediately after create/rotate/confirmed broadening.

## Integration plan

- Insert the change at:
  - `src/server/token-profiles/service.ts`: widen `TokenProfileMetadata.status` from only `active` to at least `active | revoked` (and keep bootstrap internal if needed); add a `deleteTokenProfile` service function that resolves owner, rejects active profiles, delegates to store, and returns `deleted/not_found/conflict` without token material.
  - `src/server/token-profiles/store.ts`: change manager listing to include retained user-owned `active` and `revoked` Token profiles while excluding `bootstrap`; update revoke to transactionally revoke current developer tokens and set `token_profiles.status = 'revoked'`, returning revoked profile metadata; add `deleteInactiveProfile` that deletes only owner-scoped inactive/revoked profiles.
  - `app/token-profile-summary.ts` and `app/token-profile-workspace.ts`: carry `profile.status`; replace `activeTokenProfiles` with status grouping/helpers such as `tokenProfileLifecycleStatus`, `managerTokenProfiles`, or `isInactiveProfile` so homepage can render both active and inactive rows with clear badges.
  - `app/token-profiles-panel.tsx`: render a simple Token profile manager list containing active and inactive profiles; show `Remove access` only for active/usable profiles; show `Delete permanently` only for inactive/revoked profiles; use safety confirmation text and clear copy warning that audit metadata may remain until retention.
  - `app/token-profile-detail-panel.tsx`: preserve direct inspection for inactive/revoked profiles; disable or hide rotate/policy/remove actions when status is revoked; expose permanent delete only for inactive/revoked profiles and navigate away after successful deletion.
  - `app/v1/prism/token-profiles/[profileId]/route.ts`: add a new DELETE route for permanent deletion instead of overloading revoke. Keep `revoke`, `rotate`, and `policy` subroutes unchanged for their existing semantics.
  - DB migration: if deletion is audited, add `token_profile_deleted` and `deleted` to `prism_activity_audit` constraints before using `insertActivityAuditRecord` for delete. Then delete the profile row in the same transaction so failure to audit fails closed.
- Why this is the correct integration point:
  - `token_profiles.status = 'revoked'` is appropriate for retained inactive access because the schema already permits it, local-tool resolution already treats `profile_status === 'revoked'` as unusable (`store.ts:471-475`), and the new product language says Remove/Revoke should make the profile inactive.
  - Deletion should be a new DELETE route because it is a separate irreversible resource lifecycle operation, allowed only after inactivity, while POST `/revoke` is a reversible-by-policy-design access removal that preserves inspection.
  - Hard deletion should use the existing FK model: `prism_developer_tokens` cascade because deleted profiles should not keep developer token verifiers; `prism_activity_audit` survives with null `token_profile_id` and retained `token_profile_name` until retention.
  - Listing should be changed at store/service level rather than UI-only so homepage, API GET, and detail route share the same retention semantics.
- Alternatives considered and rejected:
  - Keeping `token_profiles.status = 'active'` after revoke and deriving inactivity only from token metadata: rejected for new work because it conflicts with the existing lifecycle column and makes permanent delete eligibility less explicit. It may be supported only as a legacy compatibility case for rows already produced by current code.
  - Reusing `/revoke` for permanent deletion: rejected because revoke is already non-destructive and audited as `token_profile_revoked`.
  - Deleting audit rows with the profile: rejected because metadata-only audit retention is an explicit system owner and FK design says audit survives profile deletion.
  - Client-side-only inactive grouping: rejected because refresh/API/detail routes would drift.

## Regression checklist

- Behavior: Homepage shows both active and inactive/removed Token profiles with clear status badges; revoked profiles are no longer hidden by default.
- Behavior: Active profiles offer Remove access; inactive/revoked profiles offer permanent delete; active profiles cannot be permanently deleted.
- Behavior: Remove access revokes developer tokens, sets profile lifecycle inactive/revoked, removes usability, and preserves detail/audit inspection.
- Behavior: Permanent delete removes the Token profile row and developer-token verifier rows, but does not manually purge audit rows before retention.
- Behavior: Deleted profile detail route returns not found or an equivalent unavailable state; homepage no longer lists it after refresh.
- Behavior: Copy-once token rules for create, rotate, and confirmed broadening remain unchanged.
- Behavior: Existing no-secret invariants remain: no Prism developer token, hash, pepper, Slack token, OAuth secret, or Slack payload/content appears in list/detail/delete/audit responses.
- Behavior: `Cache-Control: no-store` and request-id headers remain on all lifecycle route responses, including DELETE.
- Behavior: Slack `reauth_required` continues to preserve management/inspection while marking access unavailable.
- Behavior: Local tool token resolution still rejects revoked/deleted profiles and revoked/expired tokens.

## Test plan

- Existing tests to keep green:
  - Full `npm test` and `npm run build` after implementation.
  - Existing route/service/store tests for create/list/revoke/rotate/policy and no-secret canaries.
  - Existing audit tests for session and token-profile scoped metadata-only retention reads.
  - Existing detail workspace tests for lifecycle/policy/audit ordering and no token material.
- New tests to add before/with implementation:
  - `app/token-profiles-panel.test.tsx`: replace the current hidden-revoked expectation with active + inactive rows, status badges, Remove access only on active rows, Delete permanently only on inactive rows, and no secret canaries.
  - `app/token-profile-workspace.test.ts`: profile status/access helper tests for active, reauth-required, revoked/inactive, expired, missing, and deleted-not-listed cases.
  - `app/token-profile-detail-panel.test.tsx`: inactive detail page still renders metadata/audit, hides/disables rotate/policy/remove, shows permanent delete confirmation, and contains no token material.
  - `app/v1/prism/token-profiles/route.test.ts`: GET includes retained inactive profiles; POST `/revoke` returns profile status revoked; new DELETE rejects active profiles, deletes inactive profiles, keeps no-store/request-id, and returns no token material.
  - `src/server/token-profiles/service.test.ts`: revoke transitions profile status to revoked; delete rejects active profiles, deletes revoked profiles, and never returns/stores plaintext tokens.
  - `src/server/token-profiles/store.test.ts`: SQL includes active+revoked manager listing excluding bootstrap, owner-scoped status transition on revoke, owner-scoped delete guarded by `status = 'revoked'`, optional legacy active+revoked-token handling if supported, and no secret columns.
  - `src/server/audit/postgres-store.test.ts` or route/store tests: deletion audit type/status if added; audit rows are not manually deleted and rely on retention/FK semantics.
- Live proof required:
  - Run `npm test` and `npm run build`.
  - In a local browser on port 3732, capture homepage before revoke, Remove access confirmation, homepage showing inactive profile, inactive detail/audit, permanent delete confirmation, homepage after delete, and deleted detail not-found/unavailable state.
  - Verify browser console has no errors and network responses for list/revoke/delete have `Cache-Control: no-store` and no plaintext token/secret material.

## Risk assessment

- Risk: Updating `listProfiles` to include revoked profiles may unexpectedly surface bootstrap or deleted states. Mitigation: explicitly exclude `bootstrap`, and only return statuses meant for the manager.
- Risk: Existing tests and prior architecture brief encode old active-only homepage semantics. Mitigation: update tests/docs deliberately and flag the conflict; do not preserve the old `activeTokenProfiles` default filter.
- Risk: Marking `token_profiles.status = 'revoked'` on revoke can break detail lookup if listing still filters active. Mitigation: change listing/detail lookup in the same slice before switching revoke status.
- Risk: Permanent delete could erase audit history if implemented with manual audit deletion or wrong FK assumptions. Mitigation: never delete audit rows; rely on `ON DELETE SET NULL` plus denormalized `token_profile_name` and retention.
- Risk: Deleting a profile cascades developer-token verifier rows. This is appropriate for permanent delete, but accidental active deletes would be severe. Mitigation: guard DELETE in service and SQL with owner scope plus inactive/revoked status and test active-profile rejection.
- Risk: Duplicate active-name uniqueness permits creating a new active profile with the same name after revocation, so inactive and active rows can share a display name. Mitigation: route actions by immutable profile id and include created/status metadata in rows/confirmations.
- Risk: Adding deletion audit values without a migration will violate existing DB constraints. Mitigation: add and test the migration before writing `token_profile_deleted`/`deleted` audit rows, or consciously omit deletion audit from first implementation.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership boundaries are clear: UI renders/initiates, route handlers expose HTTP, service owns semantics, store owns transactions, audit owns retention.
  - The schema already contains the lifecycle state needed for inactive profiles and FK behavior needed for permanent delete retention.
  - Current code already has direct detail routes and profile-scoped audit reads, so retained inspection does not require a new data path.
  - Targeted baseline tests passed, and the main failing point is a known product decision conflict rather than an architectural unknown.
- Open questions:
  - Whether deletion must create its own audit event. Recommendation: yes, add `token_profile_deleted`/`deleted` via migration and fail closed if audit cannot be recorded; if speed matters, preserve existing audit rows without a deletion event and document that choice.
  - Whether legacy rows with `token_profiles.status = 'active'` but `developerToken.status = 'revoked'` should be auto-normalized to `revoked` on next list/detail/revoke or merely treated as inactive in UI/delete eligibility. Recommendation: support them as inactive for compatibility and normalize on explicit revoke/delete paths.
