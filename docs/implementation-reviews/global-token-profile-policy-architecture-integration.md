# Architecture Integration Brief: global-token-profile-policy

## Existing ownership

- Package/component/module/library:
  - Domain language owns the semantics: `CONTEXT.md` defines Global Token profile policy as deployment-wide defaults/maximums and Outside global policy as a non-revoking review/blocking state (`CONTEXT.md:83-89`, `:127-134`).
  - Current Token profile policy behavior is server-owned by `src/server/token-profiles/presets.ts` and `src/server/token-profiles/service.ts`. `buildTokenProfilePolicy` maps create/update inputs to `capabilityMap` and expiry; `createTokenProfile`, `updateTokenProfilePolicy`, and `rotateTokenProfile` own create/update/rotation rules.
  - Current persistence for profiles/tokens is `src/server/token-profiles/store.ts` over `token_profiles` and `prism_developer_tokens` (`db/migrations/0002_prism_developer_tokens.sql`, `0004_token_profile_lifecycle.sql`). No durable deployment settings table exists today.
  - Admin access is already owned by `src/server/admin/authorization.ts`, `allowlist.ts`, and `postgres-store.ts`, with UI/API under `app/admin/*` and `app/v1/prism/admin/*`. `resolvePrismAdmin` returns global/enterprise/team with broadest-match precedence.
  - Metadata-only audit is owned by `src/server/audit/activity.ts` and `postgres-store.ts`, with activity enum constraints mirrored in migrations.
  - Website UI primitives live in `app/ui.tsx`; admin UI follows server-rendered App Router pages with `dynamic = "force-dynamic"`.
- Current owner rationale:
  - The global policy is a Prism-hosted-service setting that constrains Token profile server behavior and is edited through existing Prism admin auth. It should not become client-owned form logic, Slack auth logic, or local-tool bearer-token logic.
- Source evidence:
  - Issue #35 and `CONTEXT.md` agree on deployment-wide defaults/maximums, global-admin-only edits, scoped read-only view, no Slack scope/rate-limit/audit-retention control, and non-revoking Outside global policy classification.
  - Current behavior allows presets `read_only | messages_only | full_slack_bridge | custom`, execution identities `user | bot | automatic | selectable`, experiment TTLs `24h | 7d`, destructive opt-in, read-only no-expiry, non-read-only 90 days, destructive 30 days, broadening requiring rotation, and narrowing immediate (`presets.ts`, `service.ts`, `presets.test.ts`, `service.test.ts`).

## Existing interaction model

- User/system behaviors that already exist:
  - Slack-authenticated website users create named Token profiles and receive plaintext Prism developer tokens only on create/rotate/policy-broadening success. Lists/details never return token material.
  - Token profile update classifies broadening vs narrowing; broadening returns `rotation_required` until confirmed and then issues a replacement token. Rotation can be immediate or use overlap `none | 15m | 1h | 24h`.
  - Local tools authenticate with `Authorization: Bearer prism_dev_*`; `/v1/slack/api/*` resolves stored capability maps, enforces method/surface/workspace/execution identity, and preserves Slack-shaped denials.
  - Revoked/expired/missing profiles are retained for review; delete is blocked while active access exists.
  - Admin pages and APIs use `prism_session`, `loadAdminAllowlist`, `resolvePrismAdmin`, no-store JSON, generic 401/403, and server-side rendering.
- Behaviors that must remain unchanged:
  - Existing token use for a profile outside a newer global maximum must continue until normal expiry/revocation; do not silently revoke, delete, rewrite capability maps, or invalidate local-tool calls solely because policy changed.
  - Broadening, rotation, and reissue for Outside global policy profiles must be blocked until narrowed. Narrowing must remain available.
  - Developer token plaintext remains copy-once only; settings/audit/admin responses must not include token secrets, hashes, peppers, Slack credentials, Slack payloads, or allowlist internals.
  - Global policy must not control Slack OAuth scopes, Slack workspace membership, Slack method registry support, Slack/Prism rate limits, or audit retention.
- Runtime or UX evidence:
  - Admin console currently has placeholders for global policy (`app/admin/admin-shell.tsx:59-63`) and existing user directory navigation.
  - Token profile UI posts to existing REST routes and displays server responses; it currently hard-codes create default `read_only` and `automatic` in `app/token-profile-form.ts` / `app/token-profiles-panel.tsx`.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add a server-only global policy module under `src/server/token-profiles/` or `src/server/admin/` with pure policy DTOs, seed/default helpers, max validation, Outside global policy classification, and explicit error codes. Prefer `src/server/token-profiles/global-policy.ts` for enforcement/classification ownership, plus a Postgres store file.
  - Add a migration after `0010` for a durable singleton/settings record. Recommended shape: a keyed `prism_settings` table (`key text primary key`, `value jsonb not null`, `version integer not null`, `updated_by_prism_user_id`, `updated_at`) with key `global_token_profile_policy`, or a dedicated singleton `global_token_profile_policy_settings` table. Use JSONB for evolvable policy shape and metadata columns for audit/editor attribution.
  - Seed from current behavior using the same constants/functions as `presets.ts`: allowed presets all current presets; default preset `read_only`; allowed/default execution identity include current identities with default `automatic`; max capabilities equal current most-permissive `full_slack_bridge`/custom behavior including destructive opt-in; expiry maxima equivalent to current behavior (read-only may be no-expiry, non-read-only 90d, destructive 30d, experiments 24h/7d); broadening requires rotation; rotation overlap max 24h.
  - Extend `TokenProfileStore` or add a companion store method to fetch the effective global policy during create/update/rotate and admin display. Keep enforcement in service-layer functions, not route handlers.
  - Add admin APIs under `/v1/prism/admin/token-profile-policy` for GET and PATCH/PUT. Use existing `resolvePrismAdmin`; any authorized admin may GET, only `scope.kind === "global"` may update.
  - Add admin page/component under `/admin` (for example `/admin/token-profile-policy`) reusing `AdminConsoleShell` patterns and `app/ui.tsx` primitives. Server-render the effective policy and pass editable/read-only mode by admin scope.
  - Extend `TokenProfileMetadata`/`TokenProfileSummary` with an explicit policy classification such as `globalPolicyStatus: "inside" | "outside"` plus safe reasons/codes. Avoid returning raw policy JSON unless intentionally displayed.
  - Use `insertActivityAuditRecord` / `createPostgresActivityAuditStore` for metadata-only settings-change audit, adding a new activity type/status migration entry if needed (for example `global_token_profile_policy_updated`, status `updated`).
- Relevant docs or library capabilities:
  - ADR 0001 establishes Next.js App Router + plain Postgres; use migrations and route handlers, not Supabase/PostgREST.
  - Existing no-store/request-ID route pattern should be copied from `/v1/prism/admin/session` and `/v1/prism/token-profiles`.
- Existing examples in this codebase:
  - `src/server/admin/user-directory.ts` shows server-only admin read DTO shaping and redaction.
  - `src/server/token-profiles/service.ts` is the right create/update/rotate gate for requested profile policy.
  - `src/server/token-profiles/method-policy.ts` demonstrates explicit Slack-compatible denial bodies; create/update can use Prism JSON `{ error, message, field/reason }` responses instead.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a second admin auth/session path, Slack-role check, JWT, client-only admin gate, or developer-token-admin path. Use `prism_session` + `resolvePrismAdmin`.
  - Do not put global-policy enforcement in React form code or route handlers only. The server Token profile service must own validation so all create/update callers are covered.
  - Do not bypass `buildTokenProfilePolicy`/current capability map semantics by constructing incompatible maps in migrations, UI, or admin APIs.
  - Do not change Method registry, Slack OAuth scopes, Slack credential custody, rate limiter, or audit retention for this slice.
  - Do not silently mutate, revoke, delete, or expire existing profiles when policy maxima tighten.
  - Do not store or audit secrets/content: no Prism developer tokens, token hashes, peppers, Slack tokens, credential envelopes, Authorization headers, Slack payloads, message/search/file/canvas/list content.
- Shortcuts or parallel paths to avoid:
  - No hard-coded policy defaults duplicated separately in UI and service. If UI needs defaults/options, expose a safe effective-policy DTO from the server/admin route/page.
  - No separate database role table for global admins; existing allowlist scopes are source of truth.
  - No profile classification based only on preset labels. Compare actual `capability_map`, execution identity, expiry, mutation/rotation rules, and destructive/files/search/write capability booleans.
  - No local-tool runtime denial solely for outside-policy classification; acceptance says existing token use continues.
- Invariants:
  - Global policy is deployment-wide singleton/effective setting.
  - Defaults prefill or apply to missing user choices; maximums reject disallowed create/update/broadening requests with explicit errors.
  - Scoped admins can view but cannot edit. Global admins can edit and generate metadata-only audit.
  - Outside global policy is visible/reviewable and blocks broadening/rotation/reissue until narrowed, without revoking current token use.

## Integration plan

- Insert the change at:
  - **Migration:** add the settings table/singleton and seed row in a new migration. Also extend `prism_activity_audit` CHECK constraints if a new settings audit activity type is introduced.
  - **Policy domain:** add `src/server/token-profiles/global-policy.ts` for types, seeded-current-policy builder, validation, defaults application, and outside-policy classifier. Keep it pure and unit-tested.
  - **Policy store:** add `src/server/token-profiles/global-policy-store.ts` (or admin settings store) with `getEffectiveGlobalTokenProfilePolicy`, `upsert/update`, and transaction-safe seed/read behavior. Start with `import "server-only"` and add dependency-guard coverage.
  - **Token profile service:** thread the effective policy into `createTokenProfile`, `updateTokenProfilePolicy`, and `rotateTokenProfile`. Create/update should validate requested next policy against maxima before persistence. Rotation/reissue should first classify current profile; if outside, return an explicit blocked result unless the same operation narrows it into policy. Listing/detail should classify profiles for display without changing token validity.
  - **Routes:** update `/v1/prism/token-profiles` and `/policy` route error mapping for explicit policy errors (`400` or `409` as appropriate), preserving no-store/request ID. Update rotate route to map outside-policy blocked rotation to `409` with a safe message.
  - **Admin API/UI:** add `/v1/prism/admin/token-profile-policy` GET and PATCH/PUT plus `/admin/token-profile-policy` UI. Server-side page auth controls editability; scoped admins receive read-only controls/copy. Update admin nav to include Global Token profile policy.
  - **Audit:** record only metadata for admin settings changes: admin actor Prism/Slack IDs, endpoint, request ID, activity type, status, and maybe action category/version. Do not store full policy diffs if they could include free text later; if diff metadata is needed, keep reason codes/counts only.
- Why this is the correct integration point:
  - `presets.ts`/`service.ts` already own Token profile semantics and are covered by tests. Adding policy validation there prevents UI/API drift and avoids parallel enforcement.
  - Existing admin resolver already encodes global vs scoped admins, exactly matching edit vs read-only requirements.
  - A durable settings row in Postgres matches the project substrate and issue wording while avoiding a new configuration service.
- Alternatives considered and rejected:
  - **Environment JSON policy:** rejected because acceptance requires durable settings and admin editing.
  - **Client-only disabled options:** rejected because API callers could bypass it and existing route tests assert server behavior.
  - **Adding policy checks to local-tool forwarding:** rejected for outside-policy classification because existing token use must continue. Forwarding should continue enforcing the persisted profile capability map.
  - **Automatic backfill/narrowing of profiles:** rejected because docs require flagging for review instead of silent revoke/rewrite.
  - **Dedicated Slack/admin scope integration:** rejected because policy is Prism-local and must not control Slack scopes/workspace membership.

## Regression checklist

- Behavior: Existing create/list/update/rotate/revoke/delete Token profile flows keep endpoint paths, no-store/request-ID headers, copy-once token semantics, duplicate-name behavior, and metadata-only audit behavior.
- Behavior: Current seeded global policy allows every Token profile that current code allows, so rollout does not change defaults or maximums.
- Behavior: Broadening still requires explicit confirmation and token rotation; narrowing still applies immediately.
- Behavior: Outside-policy profiles remain usable by local tools until normal expiry/revocation and appear flagged in user/admin views.
- Behavior: Outside-policy profiles cannot rotate/reissue/broaden until narrowed; explicit safe errors are returned.
- Behavior: Global admins can edit policy; enterprise/team admins can view only; non-admins/missing sessions are denied generically.
- Behavior: Policy settings changes create metadata-only audit and fail safely if audit persistence is required and unavailable.
- Behavior: Policy does not alter Slack scopes, Slack workspace membership, Method registry support, Slack/Prism rate limits, or audit retention.
- Behavior: No response, audit row, UI, test fixture, SQL log, or docs output leaks Prism developer tokens, token hashes, peppers, Slack credentials, credential envelopes, Authorization headers, or Slack payload content.
- Behavior: New server modules remain server-only; no settings store imports into client components.

## Test plan

- Existing tests to keep green:
  - Full `npm test` and, for confidence before merge, `npm run build`.
  - Token profile tests: `src/server/token-profiles/{presets,service,store,method-policy,local-tool-status,execution-identity,developer-token}.test.ts` and `app/v1/prism/token-profiles/route.test.ts`.
  - Admin tests: `src/server/admin/{authorization,allowlist,postgres-store,user-directory,postgres-user-directory-store}.test.ts`, `app/admin/*/*.test.tsx`, `app/v1/prism/admin/*/route.test.ts`.
  - Audit/no-secret/guard tests: `src/server/audit/{activity,postgres-store}.test.ts`, `app/activity-audit-panel.test.tsx`, `src/server/dependency-guard.test.ts`, `src/server/docs-guard.test.ts`.
- New tests to add before/with implementation:
  - Pure global-policy tests: seeded policy equals current behavior; default application; max preset/identity/capability/expiry/rotation validation; explicit error codes/messages; non-goals not represented.
  - Store/migration tests: durable settings row is created/seeded; read returns seed when absent if that is the chosen behavior; update persists version/metadata; selected columns contain no secret-bearing fields.
  - Service tests: create/update allowed under seed; disallowed preset/identity/capability/expiry rejected; update narrowing from outside to inside allowed; broadening outside rejected; rotation/reissue outside rejected; existing local-tool status/method policy still allows current token use.
  - Classification tests: profiles exceeding capability, execution identity, expiry, destructive/files/search/write maxima are `outside`; revoked/expired profiles are classified for display but not reactivated; reason codes are safe and deterministic.
  - Admin authorization tests: global PATCH succeeds, enterprise/team PATCH returns 403/read-only, all scopes GET effective policy, non-admin/missing deny generically, no allowlist internals leak.
  - Route/UI tests: admin policy page renders editable global view and read-only scoped view; token profile list/detail display Outside global policy state; route responses keep no-store/request ID and no secret canaries.
  - Audit tests: settings update writes metadata-only activity and does not persist full policy body, secrets, Slack payload, or token material.
- Live proof required:
  - Run migrations locally against Postgres; verify the seed row matches current defaults and app starts.
  - As a global admin, open `/admin/token-profile-policy`, change a harmless maximum/default, save, and verify no-store admin API response plus metadata-only audit entry.
  - As enterprise/team scoped admin, verify the same page is readable but edit controls are disabled/absent and PATCH is forbidden.
  - Create/update a profile within policy, then tighten a maximum and verify the existing profile is flagged Outside global policy, local-tool `/v1/prism/status` or a harmless Slack-compatible denial/allowed path still resolves token status, rotation is blocked, and narrowing clears the flag.
  - Capture browser evidence for global editable and scoped read-only policy views, outside-policy badge, network headers, and console free of errors/secrets.

## Risk assessment

- Risk: Seeding too narrowly could break existing create/update defaults on rollout. Mitigation: derive seed from current `presets.ts` behavior and add explicit seed parity tests.
- Risk: Policy validation duplicated between UI and service could drift. Mitigation: service owns enforcement; UI consumes effective-policy DTO only for display/prefill.
- Risk: Outside-policy classification could accidentally revoke or deny local-tool runtime calls. Mitigation: keep forwarding/method-policy based on persisted profile capability map; block only create/update broadening, rotation, and reissue flows.
- Risk: Schema/audit enum mismatch could make settings updates fail in production. Mitigation: migration updates CHECK constraints and tests assert audit insert parameters.
- Risk: Secret leakage through admin settings diffs or profile metadata. Mitigation: audit metadata only, DTO allowlists, canary tests, and existing redaction helpers.
- Risk: Expiry comparisons are time-relative and can misclassify if policy stores absolute dates. Mitigation: store maxima as durations/null-allowed rules, compare from created/updated time consistently, and test boundary cases.
- Risk: Current UI create modal defaults are hard-coded and may ignore policy defaults. Mitigation: admin/user pages should fetch/use safe effective defaults for prefill after server-side default application is added.

## Decision confidence

- Confidence: medium-high
- Reasons:
  - Ownership and extension points are clear: Token profile server modules own enforcement, admin modules own authorization, Postgres owns durable settings, audit modules own metadata-only records.
  - The seed can be reconstructed from current `presets.ts` and tests, and existing admin scope semantics exactly match edit/read-only requirements.
  - Medium remains because there is no existing settings subsystem, no existing global-policy DTO, and the exact durable JSON schema/versioning must be designed carefully before implementation.
- Open questions:
  - Should the durable store be a generic `prism_settings` table for future deployment settings, or a dedicated singleton policy table? Either is viable; prefer generic only if kept minimal and strongly typed at service boundaries.
  - Should admin audit store only an update event/version, or also safe field-level reason codes/counts? Avoid full diffs unless explicitly approved.
  - What exact UI route should be canonical: `/admin/token-profile-policy` or a panel on `/admin`? A dedicated route is cleaner for tests and scoped read-only display.
