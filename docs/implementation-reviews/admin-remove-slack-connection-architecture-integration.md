# Architecture Integration Brief: admin-remove-slack-connection

## Existing ownership

- Package/component/module/library:
  - Self-service Prism-local Slack connection removal is owned by `src/server/slack/connection-management.ts` and `app/v1/prism/slack-connection/route.ts`.
  - Admin authentication/scope is owned by `src/server/admin/authorization.ts`, `src/server/admin/allowlist.ts`, and `src/server/admin/postgres-store.ts`.
  - Admin user directory/detail is owned by `src/server/admin/user-directory.ts`, `src/server/admin/postgres-user-directory-store.ts`, `app/admin/users/admin-users.tsx`, and admin user API routes under `app/v1/prism/admin/users/**`.
  - Existing cross-user admin mutation pattern is owned by `src/server/admin/token-profile-actions.ts` plus `app/v1/prism/admin/users/[userId]/token-profiles/**` routes and `app/admin/users/admin-token-profile-actions.tsx`.
  - Activity audit is owned by `src/server/audit/activity.ts`, `src/server/audit/postgres-store.ts`, `src/server/audit/presentation.ts`, `app/activity-audit-panel.tsx`, and `db/migrations/*`.
- Current owner rationale:
  - Current self-service removal already performs the correct local reset shape: select target connection from Prism session, insert metadata-only audit with `upstreamCalled: false`, then `delete from slack_connections` in a transaction. It imports no Slack Web/API client.
  - Admin token actions already define the server-side admin action contract: `resolvePrismAdmin`, generic not-found for missing/out-of-scope targets, exact typed confirmation, trimmed bounded reason (`240` chars), admin actor/reason audit metadata, no-store JSON responses, and `X-Prism-Request-ID`.
  - The admin directory store is currently the only scoped read model for target Prism users; disconnected visibility must be added there rather than creating a parallel admin lookup.
- Source evidence:
  - `src/server/slack/connection-management.ts` records `slack_connection_removed` then deletes `slack_connections` by `id` and `prism_user_id`.
  - `db/migrations/0001_slack_oauth_custody.sql`, `0002_prism_developer_tokens.sql`, and `0005_slack_forwarding_rate_limits.sql` define cascades from `slack_connections` -> `slack_credentials`/`token_profiles` -> `prism_developer_tokens`/`slack_forwarding_rate_limits`.
  - `db/migrations/0003_prism_activity_audit.sql` defines audit FKs as `ON DELETE SET NULL`, preserving metadata rows after connection/profile deletion.
  - `CONTEXT.md` defines Admin action audit, Remove Slack connection, and Disconnected Prism user; current code conflicts with disconnected visibility because `postgres-user-directory-store.ts` currently `join`s only `latest_connection` and filters scope on `lc.*`.

## Existing interaction model

- User/system behaviors that already exist:
  - Self-service `DELETE /v1/prism/slack-connection` removes only the current session owner's local Slack connection, returns no-store JSON, includes `X-Prism-Request-ID`, and treats audit unavailability as a blocking `503`.
  - Slack status reads use `getSlackConnectionDisplayRecordForSession`; with no current `slack_connections` row they return `{ kind: "not_linked" }`.
  - Admin directory/detail lists only users with a latest Slack connection inside the admin scope, then fetches profiles/activity for that connection.
  - Admin token profile mutations validate admin scope through `getAdminUserDetail`, enforce confirmation/reason server-side, and collapse missing/out-of-scope/invisible targets to generic not-found.
  - Activity presentation already shows admin actor/reason fields and distinguishes `admin_token_profile_*` from self-service events.
- Behaviors that must remain unchanged:
  - Removing a Slack connection must not delete `prism_users` or `prism_sessions`; target session ownership remains, but target status becomes not linked.
  - Removal is Prism-local only: no Slack `auth.revoke`, `apps.uninstall`, Slack admin API, or Slack Web API calls.
  - Missing and out-of-scope target users must remain indistinguishable (`404 { error: "not_found" }`) for admin action routes.
  - Existing self-service removal semantics, admin token action semantics, audit retention filtering, redaction, and no-store/request-ID conventions must keep working.
- Runtime or UX evidence:
  - `app/slack-connection-actions.tsx` copy says removal is local to Prism and does not uninstall/revoke in Slack; admin UI copy should preserve and strengthen this.
  - `app/admin/users/admin-token-profile-actions.tsx` provides the destructive admin dialog pattern: required reason notice, typed confirmation, disabled submit until valid, reload/refresh on success.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add a server-only admin Slack connection action module under `src/server/admin/`, mirroring `token-profile-actions.ts`; route may resolve `AdminAuthorizationDecision` or a thin wrapper may accept session token and call `resolvePrismAdmin`, but all auth must flow through the existing admin authorization owner.
  - Add admin route under existing namespace, preferably `app/v1/prism/admin/users/[userId]/slack-connection/route.ts` with `DELETE`.
  - Reuse/extend `createPostgresSlackConnectionManagementStore` deletion semantics or extract a shared DB helper; do not reimplement Slack deletion in the route.
  - Extend `ActivityType` and migration constraint with a distinct `admin_slack_connection_removed` activity type; reuse existing admin actor/reason audit columns from `0012_admin_token_profile_action_audit.sql`.
  - Extend `AdminUserDirectoryRow`/`AdminSlackConnectionSummary` to represent disconnected state, e.g. `status: "healthy" | "reauth_required" | "not_linked"` with nullable `id`/`updatedAt` where needed, instead of fabricating a live connection id.
  - Extend `postgres-user-directory-store.ts` scoped query to include disconnected users via retained `prism_users` Slack identity metadata and/or retained `prism_activity_audit` metadata (`slack_user_id`, `slack_team_id`, `slack_enterprise_id`, admin audit rows) when no current `slack_connections` row exists.
  - Reuse `ActivityAuditPanel` for both admin and target visibility; add a label for `admin_slack_connection_removed`.
- Relevant docs or library capabilities:
  - Next.js route handlers already use `NextRequest`/`NextResponse`; current route convention is local helper `noStoreJson` setting `Cache-Control: no-store` and `X-Prism-Request-ID`.
  - Radix/shadcn dialog/input/textarea components are already used for destructive admin actions.
- Existing examples in this codebase:
  - `src/server/admin/token-profile-actions.ts` for confirmation/reason validation and admin actor metadata.
  - `app/v1/prism/admin/users/[userId]/token-profiles/[profileId]/route.ts` and `/revoke/route.ts` for route error mapping.
  - `src/server/slack/connection-management.test.ts` for proving no credential material is selected and only local DB deletion occurs.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass `resolvePrismAdmin`, `loadAdminAllowlist`, or `createPostgresAdminIdentityStore`.
  - Do not create a separate admin directory/detail query path or an audit table; extend `user-directory`/`postgres-user-directory-store` and existing activity audit.
  - Do not mutate `slack_connections` directly in a route handler; keep state change/audit in a server-side service/store transaction.
  - Do not use Slack Web API/client modules (`web-api-client`, `oauth-client`, `forwarding-credentials`) in the removal action.
- Shortcuts or parallel paths to avoid:
  - Do not call Slack `auth.revoke`, `apps.uninstall`, admin APIs, or any `/v1/slack/api/*` forwarding path.
  - Do not reuse `slack_connection_removed` for admin removal if presentation must distinguish admin vs self-service; add `admin_slack_connection_removed`.
  - Do not overload target `slack_user_id` fields as admin actor metadata; use `admin_actor_*` and `admin_reason`.
  - Do not make disconnected users globally visible merely because they have audit rows; scope must be proven by team/enterprise metadata.
  - Do not leak existence by returning distinct errors for deleted connection vs out-of-scope target.
- Invariants:
  - Audit must be written before destructive delete and in the same transaction; if audit insert fails, no deletion.
  - Audit must be metadata-only: target/user IDs, scope IDs, object refs, endpoint, request ID, admin actor, reason; no Slack payloads/tokens/secrets.
  - Cascades must remove `slack_credentials`, `token_profiles`, `prism_developer_tokens`, and `slack_forwarding_rate_limits` through existing FK chains.
  - Route responses must be no-store, request-ID-bearing, explicit, and secret-free.

## Integration plan

- Insert the change at:
  1. Add migration `0013_*` extending the audit activity type check with `admin_slack_connection_removed` only; no new admin audit columns are needed if `0012` is present.
  2. Extend `src/server/audit/activity.ts`, `src/server/audit/presentation.ts`, `src/server/audit/postgres-store.ts` type coverage if needed, and `app/activity-audit-panel.tsx` label.
  3. Add `src/server/admin/slack-connection-actions.ts` (name flexible) that:
     - accepts admin decision/session wrapper, target `userId`, `confirmation`, `reason`, audit request metadata, and now;
     - validates `confirmation === "REMOVE"` and non-empty trimmed reason <= 240 before mutation;
     - resolves target via the existing admin-scoped detail/read model or a small store method in `AdminUserDirectoryStore` that returns the current connection only if in scope;
     - inserts `admin_slack_connection_removed` with target metadata plus admin actor/reason and `upstreamCalled: false`;
     - deletes the target current `slack_connections` row by connection id and `prism_user_id` in the same transaction.
  4. Add `DELETE /v1/prism/admin/users/[userId]/slack-connection` following existing admin token action route conventions.
  5. Extend `src/server/admin/postgres-user-directory-store.ts` so directory/detail can return Disconnected Prism users after connection deletion when scope is proven by retained `prism_users` Slack IDs and/or retained audit metadata. Fetch activity for disconnected users by `prism_user_id` (and retained scope) rather than requiring current `slack_connection_id = $2` when there is no connection.
  6. Extend `app/admin/users/admin-users.tsx` and/or a sibling client component for the detail page action using existing Dialog/Input/Textarea/Button/Notice patterns and copy explicitly stating Prism-local only, no Slack revoke/uninstall/admin/Web API call, cascaded local tokens/profiles/credentials/rate limits, and audit visibility.
- Why this is the correct integration point:
  - It keeps admin auth, scoped target resolution, destructive local connection semantics, and audit presentation in their existing owners while adding only the missing admin-specific orchestration.
  - It uses the existing FK cascade substrate rather than inventing manual cleanup logic.
  - It fixes the documented/current-code conflict around Disconnected Prism user visibility at the read-model owner.
- Alternatives considered and rejected:
  - Route-level SQL deletion: rejected because it bypasses service/store transaction and audit ownership.
  - Separate admin audit table: rejected because Admin action audit is already modeled in `prism_activity_audit` with admin metadata.
  - Slack API revocation/uninstall: rejected by product boundary and current self-service semantics.
  - Keeping admin directory tied only to `slack_connections`: rejected because it violates the agreed Disconnected Prism user behavior.

## Regression checklist

- Behavior: Self-service Remove Slack connection still deletes only the session owner's local connection, writes `slack_connection_removed`, returns no-store/request ID, and makes status not linked.
- Behavior: Admin token profile revoke/delete routes, audit labels, and reason validation remain green.
- Behavior: Admin remove accepts only in-scope targets with a current local Slack connection and returns generic `404 not_found` for missing, out-of-scope, already-disconnected without scoped proof, or invisible targets.
- Behavior: Admin remove preserves `prism_users` and `prism_sessions`; target status reads `not_linked` after deletion.
- Behavior: Disconnected users remain visible only to scoped admins when retained `prism_users` or audit metadata proves team/enterprise/global scope; they do not leak across scopes.
- Behavior: Audit rows are visible to target user activity and admin detail activity, distinguish admin removal from self-service removal, and show admin actor/reason safely.
- Behavior: No Slack API/Web API/admin client is imported or invoked by admin removal.
- Behavior: Cascades remove credentials, token profiles, developer tokens/verifiers, and forwarding rate limits; no stale local tool token can forward after removal.
- Behavior: All admin API responses include `Cache-Control: no-store` and `X-Prism-Request-ID`; response bodies contain no secrets.

## Test plan

- Existing tests to keep green:
  - `src/server/slack/connection-management.test.ts`
  - `app/v1/prism/slack-connection/route.test.ts`
  - `src/server/admin/token-profile-actions.test.ts`
  - `app/v1/prism/admin/users/**/*.test.ts`
  - `src/server/admin/postgres-user-directory-store.test.ts`
  - `src/server/audit/*.test.ts` and `app/activity-audit-panel`/admin user UI tests where present
  - Full `npm test` and `npm run build` after implementation.
- New tests to add before/with implementation:
  - Service tests for admin remove success, unauthenticated/forbidden, generic not-found for out-of-scope/missing/already-removed, invalid confirmation, blank/overlong reason, audit-unavailable blocks deletion, local-only no Slack client calls/imports, and secret canaries.
  - Store/DB tests proving deletion selects no credential/token secret columns, writes `admin_slack_connection_removed` with target metadata and admin actor/reason, then deletes only target current connection.
  - Cascade proof: with relational test fixture or SQL assertions, prove deleting `slack_connections.id` removes `slack_credentials`, `token_profiles`, `prism_developer_tokens`, and `slack_forwarding_rate_limits` through FKs, while audit/prism user/session remain.
  - Route tests for `DELETE /v1/prism/admin/users/[userId]/slack-connection`: headers, request ID, status codes, JSON errors, validation, audit unavailable, and secret-free bodies.
  - Admin directory/detail tests for disconnected visibility using retained `prism_users` scope metadata and admin audit metadata, including hidden out-of-scope disconnected users.
  - UI tests for admin detail action copy, typed `REMOVE`, required reason, disabled submit, error messages, success refresh/reload, disconnected/not-linked display, and no secrets.
  - Audit presentation tests for `admin_slack_connection_removed` label and actor/reason display.
- Live proof required:
  - Migrate/start local app, sign in as scoped admin, remove an in-scope target connection from `/admin/users/[userId]`, and capture that the route returns no-store + `X-Prism-Request-ID`.
  - Verify no Slack Web/API requests occur during removal (network/server logs or instrumentation).
  - Verify target `/` or status path shows not linked, target session/user remains, admin directory/detail still shows the disconnected user in scope, and audit shows admin actor/reason.
  - Verify old local tool/developer token no longer forwards and dependent local rows are gone.

## Risk assessment

- Risk: Current admin directory is connection-anchored; deleting the row can make the target disappear and hide the audit.
- Risk: Scope-proof logic for disconnected users could leak users across team/enterprise boundaries if it treats any retained audit as sufficient without matching `slack_team_id`/`slack_enterprise_id`.
- Risk: Audit row FKs use `ON DELETE SET NULL`; implementers must preserve denormalized Slack/team/enterprise/object metadata before deletion so disconnected scope and presentation still work.
- Risk: A route-level implementation could accidentally skip audit or delete even when audit insertion fails.
- Risk: Manual cleanup could drift from FK cascades or miss `slack_forwarding_rate_limits`; rely on cascades and test them.
- Risk: UI/admin copy could imply Slack administrative revocation; copy must say local Prism reset only.
- Mitigation:
  - Extend the existing read model deliberately, keep mutation transactional, assert no Slack client usage, and add cascade/read-model/audit tests with out-of-scope negative cases.

## Decision confidence

- Confidence: medium-high
- Reasons:
  - Ownership and mutation/audit patterns are clear from self-service removal and #37 admin token actions.
  - The required deletion behavior fits existing FK cascades and status semantics.
  - The main architectural gap is disconnected admin visibility: current code conflicts with `CONTEXT.md`/issue #38 and needs careful read-model extension using retained metadata without scope leakage.
- Open questions:
  - Exact disconnected row shape in `AdminUserDirectoryRow` should be finalized during implementation (`slackConnection.id` nullable vs synthetic absent summary). Prefer nullable/explicit `not_linked`, not fake connection IDs.
  - Whether scope proof should prioritize `prism_users` retained Slack IDs, audit metadata, or both when they disagree; safest rule is require a match to the admin scope and prefer current connection when present, then latest retained admin removal audit, then `prism_users` metadata.
