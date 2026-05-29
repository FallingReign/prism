# Architecture Integration Brief: Admin action audit for cross-user Token profile actions

## 1. Existing ownership map

### Feature / behaviour being changed

Issue #37 adds scoped admin ability to revoke or delete another in-scope Prism user's visible retained Token profiles, with typed confirmation, required admin reason, and admin action audit visible to both admins and the target user. Slack connection removal remains out of scope.

### Current owners

- Admin authentication and scope resolution are owned by `src/server/admin/authorization.ts`, backed by the allowlist loader/store in `src/server/admin/allowlist.ts` and `src/server/admin/postgres-store.ts`.
- Admin user directory and user detail read models are owned by `src/server/admin/user-directory.ts` and `src/server/admin/postgres-user-directory-store.ts`.
- Admin user pages/API are owned by `app/admin/users/**` and `app/v1/prism/admin/users/[userId]/route.ts`.
- Token profile lifecycle is owned by `src/server/token-profiles/service.ts` and `src/server/token-profiles/store.ts`.
- Activity audit modeling, persistence, and display presentation are owned by `src/server/audit/activity.ts`, `src/server/audit/postgres-store.ts`, `src/server/audit/presentation.ts`, and `app/activity-audit-panel.tsx`.
- Database ownership for audit and token profile lifecycle lives in migrations under `db/migrations/`, especially `0003_prism_activity_audit.sql`, `0006_token_profile_deletion_audit.sql`, `0010_slack_connection_removal_audit.sql`, and `0011_global_token_profile_policy.sql`.

### Existing contracts and invariants

- Admin authorization must flow through `resolvePrismAdmin`; admin scopes are `global`, `enterprise`, or `team` and are matched against the target user's current Slack enterprise/team metadata.
- Admin directory/detail must return metadata only. It must not expose developer tokens, Slack OAuth tokens, token hashes, peppers, refresh tokens, access tokens, client secrets, or allowlist internals.
- Missing and out-of-scope admin targets intentionally collapse to generic `404 { error: "not_found" }`.
- Missing sessions return `401`; authenticated non-admins return generic `403 { error: "forbidden" }`.
- Token profile revoke/delete operations must stay scoped by target `prism_user_id`, `slack_connection_id`, and `token_profile_id`.
- Delete is only valid for inactive/revoked token profiles; active profiles must be revoked before deletion.
- Lifecycle mutations and audit insertions should occur in the same transaction.
- Admin APIs should preserve the existing route pattern: no-store responses, `X-Prism-Request-ID`, JSON errors, and no secret echoing.
- Activity audit is metadata-only and retained by `retention_expires_at`.

## 2. Current interaction model

### User / system flow today

- A Prism user self-manages Token profiles through routes under `app/v1/prism/token-profiles/**`.
- `revokeTokenProfile` resolves the session owner and revokes developer tokens for a profile owned by that user.
- `deleteTokenProfile` resolves the session owner and deletes only inactive profiles owned by that user.
- The token profile store updates token/profile state and inserts standard audit rows such as Token profile revocation/deletion events.
- Admins can browse scoped users at `app/admin/users/page.tsx` and inspect a read-only user detail page at `app/admin/users/[userId]/page.tsx`.
- The admin detail API returns `AdminUserDetail` with `user`, visible `profiles`, and recent `activity`.
- Activity is presented through shared audit summaries and UI presentation helpers.

### Data flow today

- Admin session cookie -> `resolvePrismAdmin` -> allowlist scope -> `getAdminUserDetail` -> `createPostgresAdminUserDirectoryStore`.
- Detail store query resolves latest target Slack connection, applies admin scope SQL, then fetches visible `active`/`revoked` Token profile summaries for that connection.
- Activity query filters by target `prism_user_id`, latest `slack_connection_id`, and retention window.
- Self-service lifecycle route -> session owner -> token profile service -> token profile store transaction -> audit store/table row.

### Gaps for this slice

- Admin user detail currently exposes profiles read-only and has no admin mutation controls.
- There is no admin lifecycle route for cross-user Token profile actions.
- The token profile service/store lifecycle methods are self-service-owner oriented; implementation should add an admin-aware entry point without duplicating low-level state transitions.
- `prism_activity_audit` can record target metadata, request ID, profile ID/name, and activity type, but cannot currently distinguish admin actor identity or store a required admin reason.
- Existing activity presentation has no admin action labels or reason/actor display fields.

## 3. Integration points and extension strategy

### Recommended extension points

1. Add admin mutation service functions close to existing admin/user-directory and token-profile service boundaries:
   - Resolve the acting admin with `resolvePrismAdmin`.
   - Resolve the target user/profile through existing admin-scoped detail/store logic or a small scoped lookup in `src/server/admin/postgres-user-directory-store.ts`.
   - Delegate actual revoke/delete state transition to token profile store logic or shared transaction helpers.
2. Add new admin API routes under the existing admin API namespace, for example:
   - `app/v1/prism/admin/users/[userId]/token-profiles/[profileId]/revoke/route.ts`
   - `app/v1/prism/admin/users/[userId]/token-profiles/[profileId]/route.ts` for `DELETE`
3. Extend `AdminUserDetailView`/adjacent client component under `app/admin/users/**` to show destructive controls only for visible retained profiles.
4. Extend audit domain types and persistence in:
   - `src/server/audit/activity.ts`
   - `src/server/audit/postgres-store.ts`
   - `src/server/audit/presentation.ts`
   - `app/activity-audit-panel.tsx`
5. Add the next migration to extend `prism_activity_audit` with admin audit metadata.

### Minimal schema extension

The current audit table is insufficient for the acceptance criteria because it lacks a distinct admin actor and required reason. Add nullable metadata-only columns:

- `admin_actor_prism_user_id text null`
- `admin_actor_slack_user_id text null`
- `admin_actor_slack_display_name text null` if display is needed in UI; otherwise resolve/display from IDs only.
- `admin_reason text null`

Also extend the activity type constraint/enum values with explicit action types, for example:

- `admin_token_profile_revoked`
- `admin_token_profile_deleted`

Keep columns nullable so existing audit rows remain valid. Store no request payloads, tokens, hashes, secrets, or Slack OAuth material. Cap and trim `admin_reason` server-side.

### Audit visibility strategy

- Insert admin action audit rows against the target `prism_user_id`, target `slack_connection_id`, and target `token_profile_id`/name.
- Include actor metadata in the new admin columns, not by overloading target `slack_user_id`.
- Existing target-user activity queries should naturally include these rows because they are tied to target `prism_user_id` and connection.
- Admin detail activity should display these rows through the same `AdminUserDetail.activity` path after summary DTO extension.
- If the self-service activity panel is used for target-user audit, extend its presentation to label admin actions and show actor/reason safely.

## 4. Do-not-bypass list

- Do not bypass `resolvePrismAdmin` or recreate admin allowlist/scope matching.
- Do not create a parallel admin user directory/detail query path if `getAdminUserDetail` or the Postgres admin store can be extended.
- Do not mutate Token profiles directly from route handlers; keep lifecycle state changes in service/store code.
- Do not write admin action audit to a separate table unless a future ADR chooses a different audit substrate. The current domain says this is activity audit with admin metadata.
- Do not overload target user fields to represent the admin actor.
- Do not expose Slack tokens, developer tokens, token hashes, peppers, refresh tokens, access tokens, client secrets, allowlist paths, or raw request bodies.
- Do not permit admin delete of active profiles; preserve existing active-token conflict semantics.
- Do not remove Slack connections in this slice.
- Do not return different outward errors for missing vs out-of-scope target users.
- Do not weaken existing retention filtering or no-store behavior.

## 5. Implementation plan

1. Add migration for admin action audit metadata.
   - Extend `prism_activity_audit` with nullable admin actor/reason columns.
   - Extend the activity type constraint to include admin revoke/delete events.
   - Preserve all existing rows and indexes.
2. Extend audit model and presentation.
   - Add admin actor/reason fields to insert/read summary types.
   - Add safe labels for `admin_token_profile_revoked` and `admin_token_profile_deleted`.
   - Ensure reason is trimmed/capped and rendered as plain text only.
3. Add an admin-scoped target/profile lookup.
   - Reuse admin auth scope logic and target latest Slack connection semantics.
   - Return generic not found for missing/out-of-scope/profile-not-visible cases.
   - Only allow profiles visible in admin detail and retained by current lifecycle rules.
4. Add admin token profile lifecycle service methods.
   - Inputs: admin session/request context, target `userId`, `profileId`, required `reason`, request ID.
   - Validate reason server-side; reject blank/overlong values with `400`.
   - Reuse token profile state transition logic and insert admin action audit in the same transaction.
   - Revoke active profiles; delete only revoked/inactive profiles.
5. Add admin API routes.
   - Follow existing admin API conventions: no-store, request ID header, JSON errors, generic 404, 401/403.
   - Do not echo secret-like request fields.
6. Add admin detail UI actions.
   - Add typed confirmation and required reason for revoke/delete controls.
   - Use `REVOKE` for revoke and `DELETE` for delete, following the existing destructive dialog pattern in `app/slack-connection-actions.tsx`.
   - Refresh/reload detail after success so profile state and audit trail update.
7. Update tests.
   - Route tests for auth, scope, reason validation, revoke success, delete success, active-delete conflict, generic out-of-scope not found, and no secret leakage.
   - Store/service tests for transactional state change plus admin audit row.
   - UI rendering tests for gated actions, typed confirmation labels, required reason, and redaction.
   - Presentation tests for admin action activity labels and actor/reason fields.

## 6. Regression checklist

- Existing self-service revoke/delete routes still work and still attribute actions to the owner.
- Active profile delete remains rejected.
- Admins cannot act on users outside their global/enterprise/team scope.
- Missing targets, out-of-scope targets, and invisible profiles produce the same generic not-found behavior.
- Scoped admins can act only on profiles returned by the existing admin detail visibility model.
- Admin action audit appears in target-user activity and admin detail activity.
- Admin actor identity and reason are preserved in audit without replacing target identity.
- No tokens, token hashes, peppers, secrets, raw payloads, or allowlist internals appear in route responses, rendered HTML, logs, or audit fields.
- `Cache-Control: no-store` and `X-Prism-Request-ID` remain present on admin API responses.
- Existing global Token profile policy admin route/tests remain unaffected.
- Activity retention filtering continues to apply.

## 7. Test plan

### Unit / component tests

- `src/server/audit/**`: verify admin activity mapping, insert params, read mapping, presentation labels, and safe actor/reason summaries.
- `src/server/admin/**`: verify scoped target/profile lookup for global, enterprise, team, missing, out-of-scope, and invisible profile cases.
- `app/admin/users/admin-users.test.tsx`: verify destructive controls render for eligible profiles, require typed confirmation/reason, and do not render secrets.

### Route / service tests

- Admin revoke route:
  - `401` without session.
  - `403` for authenticated non-admin.
  - `404` for missing/out-of-scope target or profile.
  - `400` for missing/blank/overlong reason or failed typed confirmation if enforced server-side.
  - `200`/success for in-scope active profile with admin audit row.
- Admin delete route:
  - Same auth/scope/reason coverage.
  - Conflict for active profile.
  - Success for revoked/inactive profile with admin audit row.
- Secret canary tests should include request/DB mock strings resembling developer tokens, OAuth tokens, token hashes, refresh/access token names, client secret names, and peppers, then assert they are absent from responses/HTML.

### Integration / live QA

- Start the app against a migrated local database.
- Sign in as an admin in each relevant scope where fixtures exist.
- Open `/admin/users/[userId]`, revoke a visible target profile with typed confirmation and reason, then confirm:
  - UI state changes to revoked.
  - Admin detail activity shows admin revoke with actor/reason.
  - Target user's activity view shows the same admin action.
- Delete the revoked profile with typed confirmation and a different reason, then confirm:
  - Profile disappears or is marked deleted according to existing retained/deleted semantics.
  - Admin and target audit surfaces show admin delete.
- Attempt out-of-scope action and active delete to confirm safe errors and no state change.

## 8. Risks and mitigations

- Risk: accidentally bypassing admin scope checks during mutation.
  - Mitigation: centralize target/profile lookup behind admin scope matching and test all scope kinds.
- Risk: audit rows attribute the action to the target rather than the admin.
  - Mitigation: add explicit nullable admin actor columns and never overload target fields.
- Risk: admin reason leaks sensitive data entered by an admin.
  - Mitigation: cap length, render plain text, document reason as metadata only, and avoid raw payload storage. Do not attempt semantic secret scanning as the sole control.
- Risk: delete/revoke logic diverges from self-service lifecycle.
  - Mitigation: share store transaction helpers or call a common internal lifecycle path with an actor/audit context.
- Risk: UI can be bypassed to omit typed confirmation/reason.
  - Mitigation: enforce reason and, if included in the API contract, confirmation phrase server-side.
- Risk: current admin detail only fetches latest Slack connection profiles, so older retained profile actions could be ambiguous.
  - Mitigation: for this slice, act only on profiles visible in current admin detail. If older-connection retained profiles need action later, define that as a separate slice.
- Risk: migration constraint drift breaks existing audit inserts.
  - Mitigation: add nullable columns and route all inserts through extended defaults; keep existing activity types valid.

## 9. Decision confidence

High, with one required schema migration.

The existing code has clear ownership boundaries for admin auth, admin detail, Token profile lifecycle, and activity audit. The acceptance criteria fit those boundaries if implementation adds a small admin-scoped mutation layer, reuses Token profile lifecycle state transitions, and extends the existing audit table with explicit admin actor/reason metadata. The only material architecture gap is that current audit schema cannot represent admin actor plus required reason without either a migration or unsafe field overloading; migration is the correct integration path.
