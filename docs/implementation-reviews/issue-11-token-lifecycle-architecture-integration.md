# Architecture Integration Brief: issue-11-token-lifecycle

## Existing ownership

- Package/component/module/library:
  - **Token profile lifecycle and website session ownership:** `src/server/token-profiles/service.ts`, `src/server/token-profiles/store.ts`, `app/v1/prism/token-profiles/route.ts`, `app/token-profiles-panel.tsx`, and `app/page.tsx` own website-session-backed Token profile creation/listing and copy-once Prism developer token display. `createTokenProfile` resolves the existing `prism_session`, validates profile input, creates an opaque developer token, stores only the HMAC verifier, and returns plaintext once (`service.ts:63-108`).
  - **Developer-token verification and local-tool state:** `src/server/token-profiles/developer-token.ts` owns `prism_dev_` token issuance plus HMAC-SHA256 verifier derivation (`developer-token.ts:16-37`). `src/server/token-profiles/local-tool-status.ts` owns bearer parsing, token resolution, invalid/expired/revoked classification, Slack `reauth_required` projection, and status/capabilities response bodies (`local-tool-status.ts:68-249`). `src/server/token-profiles/store.ts#resolveDeveloperToken` owns safe SQL projection from verifier row to Token profile/Slack connection metadata without selecting Slack credential envelopes (`store.ts:99-128`).
  - **Policy and forwarding gate:** `src/server/token-profiles/method-policy.ts` owns Method registry classification handoff, workspace/surface/capability decisions, token auth-failure mapping, and Slack-shaped denied/unsupported/auth-failed bodies (`method-policy.ts:61-112`, `187-202`). `src/server/token-profiles/execution-identity.ts` owns selectable execution-mode parsing and concrete user/bot identity selection after policy approval (`execution-identity.ts:21-51`).
  - **Slack-compatible forwarding boundary:** `app/v1/slack/api/[method]/route.ts` owns request IDs, bearer extraction, policy-before-identity-before-forwarding order, policy/identity audit writes, and response diagnostics (`route.ts:29-79`). `src/server/slack/forwarding.ts` owns payload parsing, Local-tool `token` stripping, no-op rate-limit seam, audit attempt/outcome updates, default mock upstream, and unwrapped Slack-shaped success/error bodies (`forwarding.ts:25-102`).
  - **Website session/Slack connection state:** `src/server/slack/oauth-flow.ts` defines `prism_session`/hashing; `src/server/slack/postgres-store.ts` owns session-to-linked-Slack status and `healthy` vs `reauth_required` connection state (`postgres-store.ts:129-167`). Slack credential custody and refresh remain in `src/server/slack/postgres-store.ts`, `src/server/slack/refresh.ts`, and credential encryption modules, not in Token profile lifecycle code.
  - **Metadata-only audit:** `src/server/audit/activity.ts`, `src/server/audit/postgres-store.ts`, `src/server/audit/presentation.ts`, `app/v1/prism/activity/route.ts`, and `app/activity-audit-panel.tsx` own activity records, retention, current-session listing, presentation, and the no-payload/no-secret model from issue #10 (`activity.ts:20-46`, `postgres-store.ts:74-129`).
  - **Persistence:** Plain SQL migrations under `db/migrations/*.sql` own schema. `0001` creates Prism sessions, Slack connections/credentials, and the initial Token profile shell (`0001:1-63`). `0002` evolves Token profiles and adds `prism_developer_tokens` with verifier-only `token_hash`, `expires_at`, `last_used_at`, and `revoked_at` (`0002:122-140`). `0003` adds `prism_activity_audit` with explicit metadata columns only (`0003:1-53`).
- Current owner rationale:
  - `CONTEXT.md` defines a Prism developer token as an opaque bearer secret resolved server-side to exactly one Token profile, and says Local tools receive only Prism developer tokens, never Slack credentials (`CONTEXT.md:27-33`, `61-66`).
  - ADR 0001 requires Next.js route handlers plus plain Postgres and explicitly names opaque Prism token verification and metadata-only audit as core substrate requirements (`docs/adr/0001-nextjs-postgres-substrate.md:1-3`).
  - Issue #11's PRD explicitly says lifecycle operations should extend the Token profile service rather than scatter token mutation logic across route handlers, and should deepen the existing `prism_developer_tokens` semantics rather than introduce a parallel token store.
- Source evidence:
  - `prism_developer_tokens_current_profile_key` currently enforces one non-revoked token row per profile (`0002:134-136`), which conflicts with issue #11's required overlap windows unless the index/model is revised.
  - Existing local-tool status/capabilities already know `expired`, `revoked`, and `reauth_required` states but do not update `last_used_at` or expose per-verifier metadata (`local-tool-status.ts:177-199`, `202-217`).
  - Existing website UI warns that Reauth required blocks Slack calls while preserving profile management and copy-once token semantics (`app/token-profiles-panel.tsx:69-75`, `136-140`).

## Existing interaction model

- User/system behaviors that already exist:
  - Website users authenticate with the existing `prism_session` cookie. `GET|POST /v1/prism/token-profiles` list/create Token profiles only for the linked Prism user and set `Cache-Control: no-store` plus `X-Prism-Request-ID` (`app/v1/prism/token-profiles/route.ts:13-34`, `36-68`, `100-105`).
  - Creating a Token profile returns `developerToken` exactly once; profile listing and server-rendered initial profile summaries never include plaintext token, token hash, or pepper (`service.ts:91-108`, `app/page.tsx:65-78`).
  - Local tools use `Authorization: Bearer prism_dev_...` for `/v1/prism/status`, `/v1/prism/capabilities`, and `/v1/slack/api/{method}`. Missing/malformed tokens fail before DB lookup (`local-tool-status.ts:154-174`, `247-249`; route tests assert this for status and Slack-compatible endpoints).
  - `/v1/prism/status` returns active token state plus Slack connection and execution identity availability; `/v1/prism/capabilities` returns effective `CapabilityMap` plus Method registry categories/methods/unsupported only for active tokens (`local-tool-status.ts:68-134`).
  - Slack-compatible calls follow the mandatory pipeline: policy evaluation -> execution identity resolution -> forwarding. Denied/unsupported/auth-failed/identity-unavailable branches return Slack-shaped `ok:false` responses and do not call upstream (`app/v1/slack/api/[method]/route.ts:34-79`).
  - Allowed representative Slack calls go through the forwarding service and default mock upstream; successful and ordinary upstream error bodies remain unwrapped Slack-shaped JSON with Prism diagnostics in headers (`forwarding.ts:83-101`; route tests at `app/v1/slack/api/[method]/route.test.ts:190-275`).
  - Metadata-only audit already records token profile creation/listing and Slack method attempted/forwarded/denied metadata without bodies, payloads, tokens, hashes, peppers, Slack tokens, or client secrets (`src/server/audit/activity.test.ts:7-80`).
- Behaviors that must remain unchanged:
  - Local tools must never receive Slack credentials, credential envelopes, token hashes, peppers, copy-once secrets after creation/rotation, raw DB rows, or Slack scopes as policy.
  - Website session ownership remains `prism_session` + Postgres session lookup; no NextAuth/JWT/cookie fallback for Local-tool endpoints.
  - Denied/revoked/expired/auth-failed/reauth-gated paths must not select/decrypt Slack credentials, refresh Slack credentials, or call upstream.
  - Reauth required is a Slack connection state, not Token profile deletion or Prism token revocation. Token profiles remain visible/manageable, while affected Slack calls fail closed.
  - `CapabilityMap.mutation.narrowingAppliesImmediately` and `broadeningRequiresRotation` remain the policy semantics surfaced by presets and method policy (`presets.ts:47-51`, `90-94`; `method-policy.test.ts:60-80`).
- Runtime or UX evidence:
  - Tests assert no `access_token_envelope`, `refresh_token_envelope`, `xox[bp]-`, `client_secret`, Prism developer token, token hash, or pepper leakage in status/capabilities, token-profile routes, Slack-compatible routes, and panels.
  - `app/token-profiles-panel.test.tsx:7-31` verifies profile metadata rendering omits developer token material; `app/v1/prism/token-profiles/route.test.ts:83-145` verifies copy-once creation and metadata-only listing.
  - `app/v1/prism/status/route.test.ts:90-152` already expects expired/revoked/reauth/missing-identity states; issue #11 should extend, not replace, these semantics.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Extend `src/server/token-profiles/service.ts` with small lifecycle commands, e.g. `revokeDeveloperToken`, `rotateDeveloperToken`, `updateTokenProfilePolicy`, and enriched `listTokenProfiles`, using the existing `TokenProfileStore` interface pattern.
  - Extend `src/server/token-profiles/store.ts` with transaction-backed methods for verifier mutation, overlap expiry, last-used updates, policy updates, owner/profile authorization, and lifecycle audit writes. Keep all SQL here; route handlers should stay thin.
  - Extend existing App Router website API boundaries, preferably under `app/v1/prism/token-profiles/[profileId]/...` for `revoke`, `rotate`, and profile policy updates, while keeping `GET|POST /v1/prism/token-profiles` for list/create. All responses should be no-store and request-ID stamped.
  - Extend `TokenProfileMetadata` and `TokenProfileSummary` with lifecycle-safe fields: profile status, current verifier created/expiry/revoked/last-used metadata, overlap expiry, rotation state, and Slack `reauth_required` warning. Never add verifier hash/pepper/plaintext to these response types.
  - Extend `LocalToolTokenStore.resolveDeveloperToken` result with safe verifier identity such as `developerTokenId` and `tokenLastUsedAt` only if needed for last-used updates/display. Do not add plaintext, token hash, pepper, or Slack credential envelopes.
  - Extend `src/server/audit/activity.ts` and migration checks for metadata-only lifecycle events such as `token_profile_revoked`, `token_profile_rotated`, and `token_profile_policy_updated`; use explicit columns/statuses rather than payload JSON.
  - Add a new SQL migration after `0003`, likely `0004_token_profile_lifecycle.sql`, for overlap-compatible verifier constraints, lifecycle metadata, and audit enum/check updates.
- Relevant docs or library capabilities:
  - Postgres partial indexes can enforce one current replacement token while allowing temporary overlap rows. The current partial unique index on `(token_profile_id) WHERE revoked_at IS NULL` is too strict for overlap and should be replaced deliberately.
  - Next.js dynamic route handlers can model profile-scoped lifecycle commands without adding a new framework.
  - Existing `Database.transaction` is available and already used for create+verifier+audit atomicity (`store.ts:42-93`).
- Existing examples in this codebase:
  - `insertProfileWithVerifier` is the pattern for transactional profile/verifier/audit coupling; rotation should mirror it so a replacement token is not shown if persistence/audit fails.
  - `forwardSlackMethod` shows the correct pattern for pre-side-effect audit insert failures and post-side-effect update failures (`forwarding.ts:67-101`).
  - `app/page.tsx` already gathers session-scoped Slack status, Token profile summaries, and activity audit for the homepage; lifecycle UI should enrich the existing Token profiles panel, not create an admin console.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a parallel token/API-key table, plaintext token storage, JWT/self-describing token model, token scanner, or route-local verifier. Continue hashing the presented bearer token and resolving by `prism_developer_tokens.token_hash`.
  - Do not create a second policy engine, Method registry, execution identity resolver, Slack-compatible route, or forwarding path. All Slack calls must continue through `evaluateSlackMethodPolicy`, `resolveSlackExecutionIdentity`, and `forwardSlackMethod`.
  - Do not create a second website auth/session mechanism; reuse `prism_session`, `hashSecret`, `resolveOwner`, and current session-scoped Postgres patterns.
  - Do not add ORM/Supabase/PostgREST/Auth dependencies or Pages Router/Express paths; ADR 0001 and existing dependency guard direction favor plain Postgres and App Router.
  - Do not add Slack credential selection/decryption to token status, capabilities, policy denial, lifecycle UI, or lifecycle mutation paths.
- Shortcuts or parallel paths to avoid:
  - No storing/copying back replacement or old Prism developer tokens after the immediate rotation/create response. Do not put tokens in URLs, cookies, logs, localStorage, audit rows, activity panels, profile summaries, or test snapshots.
  - No treating profile revocation as profile deletion unless product explicitly changes semantics. Revoked/inactive rows are needed for audit/history and to prevent token resurrection confusion.
  - No route-level capability mutation that directly updates `capability_map` without service-level broadening/narrowing classification.
  - No broadening a stored `CapabilityMap` for an already-copied token without explicit confirmation and rotation.
  - No generic audit `details`/`payload` JSON for lifecycle events.
- Invariants:
  - Local tools receive only Prism developer tokens, never Slack credentials.
  - Prism developer tokens remain verifier-only HMAC rows; plaintext is copy-once only at creation/rotation.
  - A Prism developer token maps to exactly one Token profile. A Token profile has one current replacement token; optional previous verifiers may remain valid only until their approved overlap expiry.
  - Invalid/malformed tokens must not query DB. Unknown tokens must not update `last_used_at`. Known denied/revoked/expired/auth-failed paths must not select/decrypt Slack credentials or call upstream.
  - Successful and ordinary upstream-error Slack bodies remain unwrapped Slack-shaped JSON.
  - Metadata-only audit must not store Slack payload/body/content, Prism developer tokens, token hashes, peppers, Slack access/refresh tokens, OAuth codes/states, client secrets, or raw search/message/file content.

## Integration plan

- Insert the change at:
  - **Migration/schema:** add `db/migrations/0004_token_profile_lifecycle.sql` (name may vary, keep numeric order) to revise verifier constraints and lifecycle metadata.
    - Replace `prism_developer_tokens_current_profile_key` because `WHERE revoked_at IS NULL` prevents old+new overlap. Recommended shape: add `superseded_at timestamptz`, `superseded_by_token_id text references prism_developer_tokens(id)`, `rotation_overlap_expires_at timestamptz`, and/or `is_current boolean not null default true`; then enforce one current token per profile with a partial unique index such as `(token_profile_id) WHERE is_current = true AND revoked_at IS NULL` while allowing superseded overlap rows with `expires_at`/`rotation_overlap_expires_at` bounded.
    - Preserve existing `expires_at`, `last_used_at`, and `revoked_at`. Add check constraints so overlap expiry cannot exceed the selected window and superseded rows are not marked current.
    - Consider profile-level fields for policy lifecycle (`policy_updated_at`, `capability_broadening_pending` if a staged proposal is needed), but avoid overbuilding a workflow table unless UI needs pending review state.
    - Extend `prism_activity_audit.activity_type`/`status` CHECK constraints for lifecycle events/statuses, e.g. `token_profile_revoked`, `token_profile_rotated`, `token_profile_policy_updated`; statuses such as `revoked`, `rotated`, `updated`.
  - **Service/store lifecycle commands:** add lifecycle methods to the Token profile service and Postgres store. Each command must resolve the website session owner, verify the profile belongs to that owner/connection, run in a transaction, write metadata-only audit, and return only safe metadata plus a copy-once replacement token for rotation.
    - `revokeDeveloperToken({ sessionToken, profileId })`: set `revoked_at=now()` on all current and overlap-valid verifier rows for that profile (or a selected current verifier if product allows per-token revoke), leave the Token profile row present, record audit, and return updated profile summary.
    - `rotateDeveloperToken({ sessionToken, profileId, overlap: "none"|"15m"|"1h"|"24h" })`: issue new plaintext via `issueDeveloperToken`, hash with `hashDeveloperToken`, insert the new current verifier, supersede old current verifiers in the same transaction. For immediate rotation, set old `revoked_at=now()`. For overlap, set old `is_current=false`, `superseded_at=now()`, `superseded_by_token_id=<new id>`, and `expires_at`/`rotation_overlap_expires_at` to the selected bounded expiry while leaving them resolvable until that time. Return the new plaintext once only after transaction/audit success.
    - `updateTokenProfilePolicy(...)`: build a candidate `CapabilityMap` with existing `presets.ts`; compare current vs candidate. If every change narrows access (false-ward action/surface changes, shorter expiry, stricter execution identity), update immediately. If any change broadens access (false->true action/surface, destructive enablement, longer/no expiry, less restrictive execution identity, broader preset), require explicit confirmation and rotation before the broader map is usable. Recommended: combine broadening confirmation with `rotateDeveloperToken` in one transaction that updates the map and issues a new token; old tokens should be revoked or overlap only with the old/narrower map unless product explicitly accepts overlap using broadened policy.
  - **Local-tool resolver and last-used:** extend `resolveDeveloperToken` to select safe verifier metadata including token row id and last-used/overlap fields; use the `now` parameter currently passed but unused in SQL. After a presented token hashes to a row, update `last_used_at=now()` only for known verifier rows that are not revoked and not expired at `now` (or explicitly document if product wants expired/revoked presentations counted separately). Do not update for malformed or unknown tokens. Ensure this update remains in the token-profile store and never selects credentials.
  - **Status/capabilities/policy:** keep all lifecycle state classification in `resolvePresentedDeveloperToken`/`deniedTokenResult` so `/v1/prism/status`, `/v1/prism/capabilities`, and Slack-compatible endpoints observe the same expiry/revocation/overlap rules. Expose overlap/current/last-used metadata in status/capabilities only where safe and useful; invalid/expired/revoked responses should not include capability maps.
  - **Reauth gate:** keep `reauth_required` as `slack_connections.status`. Website should distinguish it from revoked/expired developer-token states. Slack-compatible calls should continue failing before forwarding via execution identity availability (`slack_reauth_required`), while status/capabilities continue to identify valid token + Slack reauth state.
  - **Routes/UI:** extend `app/v1/prism/token-profiles` with profile-scoped lifecycle endpoints and enrich `app/token-profiles-panel.tsx` in place. UI should show current token status, expiry, last-used, revoked/expired/reauth warnings, rotation overlap labels, revoke action, rotate action with none/15m/1h/24h choices, and copy-once replacement display. It should not create a separate admin console.
  - **Audit:** lifecycle events should call the existing audit store with typed metadata only: profile id/name, activity type, endpoint, status, request ID, maybe overlap window label and action category if represented as safe enum text. Never include token plaintext/hash/pepper or old/new verifier values.
- Why this is the correct integration point:
  - Issue #11 changes Token profile/developer-token lifecycle, so the Token profile service/store is the correct owner; route handlers and UI should delegate rather than own mutation semantics.
  - Putting expiry/revocation/overlap/last-used in the existing resolver guarantees status, capabilities, policy, and Slack forwarding share one source of truth.
  - Revising the verifier index is necessary because overlap is a persistence invariant, not a route/UI concern.
  - Reusing the audit module preserves issue #10's metadata-only invariant and avoids lifecycle-specific logs.
- Alternatives considered and rejected:
  - **Parallel `api_keys`/`token_rotations` owner:** rejected because `token_profiles` + `prism_developer_tokens` already own this domain and the PRD says to deepen them.
  - **JWT/self-describing replacement tokens:** rejected because Prism developer tokens are opaque and server-resolved.
  - **Deleting Token profiles on revoke/reauth:** rejected because reauth must preserve profiles and revocation should be auditable/manageable.
  - **Route-local overlap checks:** rejected because status/capabilities/Slack forwarding would diverge.
  - **Storing replacement tokens encrypted for retrieval:** rejected because copy-once replacement tokens must never be stored or retrievable.

## Regression checklist

- Behavior: Issue #5 copy-once Token profile creation still returns plaintext only on create, stores only HMAC verifier material, supports multiple named profiles per linked Slack user, and lists metadata without token/verifier/pepper material.
- Behavior: Issue #6 `/v1/prism/status` and `/v1/prism/capabilities` remain bearer-only, no-store, request-ID stamped, and consistent for valid, invalid, expired, revoked, Slack `reauth_required`, and missing-identity states.
- Behavior: Issue #7 Method registry and Token profile policy remain the enforcement source; no route-local allowlist or Slack-scope-as-policy path appears.
- Behavior: Issue #8 execution identity selection remains fail-closed, selectable-only for `X-Prism-Execution-Mode`, and no Slack credentials are selected for unavailable identity decisions.
- Behavior: Issue #9 Slack-compatible forwarding keeps the ordered pipeline, strips Local-tool `token` payload fields, preserves Slack-shaped success and ordinary error bodies, and never calls upstream for denied/unsupported/auth-failed/revoked/expired/reauth-gated paths.
- Behavior: Issue #10 metadata-only audit continues to use explicit metadata columns, current-session scoping, retention, no payload/body/content/secrets, and no wrapper changes to Slack-compatible bodies.
- Behavior: Reauth required remains a Slack connection state; Token profiles and verifier rows are preserved and visible/manageable.
- Behavior: Overlap windows expire automatically according to persisted verifier expiry; old tokens fail after overlap without manual cleanup.
- Behavior: `npm test` and `npm run build` remain green. Build may mutate `next-env.d.ts`; do not include that as product change.

## Test plan

- Existing tests to keep green:
  - `src/server/token-profiles/service.test.ts`
  - `app/v1/prism/token-profiles/route.test.ts`
  - `app/token-profiles-panel.test.tsx`
  - `app/v1/prism/status/route.test.ts`
  - `app/v1/prism/capabilities/route.test.ts`
  - `src/server/token-profiles/method-policy.test.ts`
  - `src/server/token-profiles/execution-identity.test.ts`
  - `app/v1/slack/api/[method]/route.test.ts`
  - `src/server/slack/forwarding.test.ts` if present/current in the suite
  - `src/server/audit/activity.test.ts`, `src/server/audit/postgres-store.test.ts`, `app/v1/prism/activity/route.test.ts`
  - Slack OAuth/refresh/encryption, dependency guard, config, health, and homepage/panel tests.
- New tests to add before/with implementation:
  - Migration/schema tests or SQL assertions proving the old unique current-token index is replaced, one current verifier per profile is enforced, temporary superseded overlap verifiers are allowed, overlap windows are bounded to 15m/1h/24h, and no plaintext/hash/pepper/audit payload columns are added.
  - Token profile service tests for immediate revocation; revocation of all active/overlap verifiers; rotation with immediate invalidation; rotation with 15-minute, 1-hour, and 24-hour overlap; overlap expiry; copy-once replacement token not persisted; duplicate/unauthorized profile handling; audit failure does not return a replacement token.
  - Local-tool resolver/status/capabilities tests for current token active, old token active during overlap, old token expired after overlap, immediate old token revoked, explicitly revoked token, profile expired, token expired, malformed token no DB query/no last-used update, unknown token no last-used update, known active token last-used update, and Reauth required valid-token state.
  - Method-policy and Slack route tests proving revoked/expired/overlap-expired/reauth-required tokens return Slack-shaped failures, set `X-Prism-Upstream-Called:false`, and do not select `access_token_envelope`/`refresh_token_envelope` or call upstream.
  - Policy update tests for narrowing vs broadening: narrowing applies immediately to existing token; broadening without confirmation/rotation is rejected or staged; broadening with explicit rotation returns a copy-once replacement and old-token behavior follows selected invalidation/overlap semantics.
  - Route tests for lifecycle endpoints: no-store, request ID, website-session auth only, ownership scoping, replacement token appears only in rotate success body, list/detail never returns token/hash/pepper, and audit rows are metadata-only.
  - UI/panel tests for visible status, expiry, last-used, revoked/expired/Reauth distinction, rotation overlap labels, revoke/rotate controls, copy-once replacement warning, and no token material in initial/server-rendered metadata.
  - Audit tests extending `ActivityType`/status checks for lifecycle events and canaries proving lifecycle audit excludes developer tokens, verifier hashes, peppers, Slack tokens, OAuth codes/states, payload/body/content, and client secrets.
- Live proof required:
  - Run `npm test` and `npm run build`.
  - Apply migrations with `npm run db:migrate` against local Postgres.
  - Start the local app with mock OAuth/upstream defaults, link/create a Token profile, and capture real HTTP evidence for:
    - status/capabilities active with last-used metadata,
    - Slack-compatible allowed call succeeds before revoke,
    - revoke makes status/capabilities/Slack-compatible calls fail with revoked state and no upstream call,
    - rotate immediate: new token works once copied, old token fails,
    - rotate with at least one overlap option: old and new work during overlap; old fails after simulated/controlled expiry,
    - Reauth required preserves Token profiles but gates Slack-compatible calls.
  - Capture website proof that Token profile details show lifecycle state, expiry, last-used, reauth warning, and overlap label without exposing stored/retrievable token material.
  - User-testing checkpoint: before finalising, loop the user in after the first live rotation/revocation flow is available. Ask them to verify the UI copy and recovery path: which action they would take for revoked vs expired vs Reauth required. Do not proceed to final review until this checkpoint is recorded or explicitly deferred.

## Risk assessment

- Risk: The existing one-current-token partial index prevents overlap; a superficial implementation may fake overlap in route code or fail in production. Mitigation: migrate the invariant explicitly and test it.
- Risk: Rotation could return a replacement plaintext token before verifier/audit persistence commits, creating an untracked secret. Mitigation: transactionally persist verifier+metadata-only audit before responding; on audit unavailable, do not show the token.
- Risk: Last-used updates could accidentally run for malformed/unknown tokens or force credential selection in denied paths. Mitigation: keep updates inside token-profile store after exact hash row lookup and before any credential custody path.
- Risk: Broadening policy during overlap could let an old copied token gain new access silently. Mitigation: require broadening+rotation and either revoke old tokens immediately or keep overlap under old/narrower effective policy; if per-token policy snapshots are not added, prefer immediate invalidation for broadening rotations.
- Risk: Audit enum/check changes could encourage generic payload JSON. Mitigation: extend typed activity/status values only and keep explicit columns.
- Risk: UI controls could make Reauth required look like token revocation/expiry, causing users to rotate unnecessarily. Mitigation: separate Slack connection warning from token lifecycle status in copy and tests.
- Risk: Multiple verifier rows per profile could make resolver choose the wrong row if hash uniqueness, current flag, and expiry rules are unclear. Mitigation: resolve by unique token hash first, then classify that exact row; do not query by profile to authenticate.
- Risk: Revoked/expired/auth-failed Slack routes could regress and call mock upstream or audit with sensitive fields. Mitigation: route tests must assert `X-Prism-Upstream-Called:false`, no credential envelope SQL, and no content/secrets.

## Decision confidence

- Confidence: high
- Reasons:
  - Existing ownership is clear: Token profile service/store owns lifecycle, local-tool resolver owns token state projection, policy/identity/forwarding already share that resolver, website panel already owns token-profile UX, and audit has an explicit metadata-only module.
  - Issue #11 mostly extends existing schema columns (`expires_at`, `last_used_at`, `revoked_at`) and service boundaries rather than requiring a new subsystem.
  - The main architectural conflict is identified and localized: `prism_developer_tokens_current_profile_key` must be replaced to support overlap.
  - Reauth required behavior already exists as Slack connection state and policy denial, so implementation should preserve and clarify it rather than inventing a new gate.
- Open questions:
  - For broadening rotations with overlap, product/security should decide whether old tokens during overlap continue under the old narrower policy or whether broadening forces immediate invalidation. Recommended default: broadening rotation invalidates old tokens immediately unless per-token policy snapshots are introduced and tested.
  - Whether `last_used_at` should update for known but expired/revoked token presentations or only active usable presentations. Recommended default: update only active non-expired/non-revoked verifier use; add a separate audit event later if attempted use of revoked/expired tokens matters.
  - Whether lifecycle detail should be a separate detail panel within `TokenProfilesPanel` or inline list expansion. Keep it in the existing Prism website Token profiles surface either way.
- Conflicts between docs and code:
  - No conflict with `CONTEXT.md`/ADR. The code/schema conflict with the issue #11 overlap requirement is the current partial unique index on non-revoked developer tokens (`0002:134-136`); implementation must resolve it in the migration, not work around it in application code.
