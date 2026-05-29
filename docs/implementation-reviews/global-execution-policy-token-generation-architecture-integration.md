# Architecture Integration Brief: global-execution-policy-token-generation

## Existing ownership

- Package/component/module/library:
  - Server-side policy authority: `src/server/token-profiles/global-policy.ts` defines `GlobalTokenProfilePolicy.executionIdentities.allowed/default`, applies defaults, validates requested policies, classifies Outside global policy, and validates rotation overlap.
  - Token profile lifecycle authority: `src/server/token-profiles/service.ts` owns create/update/rotate decisions and already threads `globalPolicyStore` through `createTokenProfile`, `updateTokenProfilePolicy`, and `rotateTokenProfile`.
  - Durable global setting: `src/server/token-profiles/global-policy-store.ts` reads/writes the `prism_settings` singleton seeded by `db/migrations/0011_global_token_profile_policy.sql`.
  - Website UX ownership: create flow is `app/token-profiles-panel.tsx` + `app/token-profile-form.ts`; detail policy editing is `app/token-profile-detail-panel.tsx`; safe policy DTO projection is `app/token-profile-policy-options.ts`.
  - Admin policy editing ownership: `app/admin/token-profile-policy/*` and `app/v1/prism/admin/token-profile-policy/route.ts`.
- Current owner rationale:
  - `CONTEXT.md` defines Global Token profile policy as a deployment-wide Prism-hosted-service default/maximum; therefore the server service must remain authoritative and UI can only represent safe choices/prefill.
- Source evidence:
  - `global-policy.ts` checks `candidate.capabilityMap.executionIdentity` against `policy.executionIdentities.allowed`.
  - `service.ts` applies global defaults and validates create/update policies before persistence; route handlers pass `createPostgresGlobalTokenProfilePolicyStore(database)`.
  - `token-profile-policy-options.ts` already exposes `executionIdentities.allowed/default` to client components.

## Existing interaction model

- User/system behaviors that already exist:
  - Users create Token profiles from a modal and receive Prism developer tokens copy-once only.
  - The create modal exposes presets/capabilities constrained by `policyOptions`, but not execution identity; `buildCreateTokenProfileModalRequestBody` hard-codes `executionIdentity: "automatic"`.
  - Detail policy editing exposes execution identity via shadcn/Radix `Select`, but its option list is hard-coded to all identities.
  - Outside global policy profiles are flagged in list/detail, remain usable until expiry/revocation, and block rotation/broadening until narrowed.
  - Admins can edit allowed/default execution identities in the durable Global Token profile policy; scoped admins view read-only.
- Behaviors that must remain unchanged:
  - No client response or audit row may reveal Prism developer token material except the copy-once create/rotate/broadening response.
  - Preset templates, manual Custom switching, destructive opt-in, experiment expiry, broadening confirmation/rotation, narrowing-immediate semantics, inactive profile locking, and Outside global policy handling must remain.
  - Server validation is the authority; UI affordances must not be the only enforcement.
  - Existing profiles outside a tightened global policy must not be silently revoked, rewritten, or denied at local-tool runtime.
- Runtime or UX evidence:
  - List/detail already receive `policyOptions` from server-rendered pages via `tokenProfilePolicyOptionsFromGlobalPolicy`.
  - Create modal copy says “Prism uses automatic execution identity…” even when global default/allowed identities differ, creating the observed UX mismatch.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Reuse `TokenProfilePolicyOptions.executionIdentities.allowed/default`; do not add a second DTO.
  - Add execution identity field serialization to `buildCreateTokenProfileModalRequestBody` using the existing `FormData` pattern and fallback to the current safe default only when omitted.
  - In `TokenProfilesPanel`, add state initialized from `policyOptions.executionIdentities.default` and render a shadcn/Radix `Select` or accessible field using project patterns from `TokenProfileDetailWorkspace.SelectField`.
  - In `TokenProfileDetailWorkspace`, derive execution identity options from `policyOptions.executionIdentities.allowed`; preserve/display the current profile identity even if it is now outside policy so users can narrow intentionally.
  - Keep server reads through `createPostgresGlobalTokenProfilePolicyStore` in pages/routes and service validation through `validateRequestedTokenProfilePolicy`.
- Relevant docs or library capabilities:
  - Next App Router pages are `force-dynamic` and pass safe server data to client components.
  - shadcn/Radix `SelectItem` supports `disabled`, and existing local `SelectField` already maps disabled options.
- Existing examples in this codebase:
  - Preset availability and capability maximum UI in `app/token-profiles-panel.tsx` and `app/token-profile-detail-panel.tsx` already model client-side representation backed by server policy.
  - `app/token-profile-policy-options.test.ts`/panel/detail/form tests use static rendering and request-body assertions for safe DTO behavior.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a parallel global policy reader, hard-coded execution identity policy, admin policy store, or client-only enforcement path.
  - Do not bypass `applyGlobalTokenProfilePolicyDefaults`, `buildTokenProfilePolicy`, `validateRequestedTokenProfilePolicy`, or `classifyGlobalTokenProfilePolicyStatus`.
  - Do not alter Method registry, Slack OAuth scope/custody, Slack credential storage, local-tool forwarding, audit retention, or admin authorization.
- Shortcuts or parallel paths to avoid:
  - Do not “fix” the issue by accepting disallowed execution identities server-side or by silently rewriting a user request in routes.
  - Do not hide a current disallowed identity in the detail editor in a way that forces accidental broadening/narrowing or makes review impossible.
  - Do not add new token-profile policy constants in UI when `policyOptions` already carries the safe server projection.
- Invariants:
  - Global Token profile policy remains durable and admin-owned.
  - Token profile service remains the enforcement authority for all create/update callers.
  - Web UX mirrors allowed/default execution identities and explains policy blocking without leaking secrets.

## Integration plan

- Insert the change at:
  - `app/token-profile-form.ts`: change create-modal serialization to read `executionIdentity` from the form with fallback to `automatic` for backwards compatibility.
  - `app/token-profiles-panel.tsx`: add a create execution identity control initialized/reset from `policyOptions.executionIdentities.default`, populated/disabled from `policyOptions.executionIdentities.allowed`, and update the “Safe defaults” copy to reflect the selected/global default instead of hard-coded automatic.
  - `app/token-profile-detail-panel.tsx`: replace hard-coded policy identity options with options derived from `policyOptions.executionIdentities.allowed`, keeping the current profile identity selectable/visible if outside the current policy and disabling blocked alternatives.
  - Tests: extend form, create panel, detail panel, and route/service/global-policy tests where gaps exist for execution identity specifically.
- Why this is the correct integration point:
  - The server path already enforces execution identity constraints when requests include an identity; the missing integration is the UX and request body generation not using the existing safe policy DTO.
  - These components already own equivalent preset/capability policy affordances, so adding execution identity there avoids a parallel path.
- Alternatives considered and rejected:
  - Route-level coercion to default identity: rejected because it hides user intent and weakens service-owned validation.
  - Client-only hiding without service tests: rejected because API callers must remain constrained server-side.
  - Admin UI changes: rejected for this slice because admin allowed/default identity editing already exists.

## Regression checklist

- Behavior: Create modal submits the selected/default allowed execution identity and still shows the Prism developer token copy-once only after successful creation.
- Behavior: If global policy disallows `automatic`, the create modal no longer submits `automatic` unless it is explicitly allowed/currently selected by policy.
- Behavior: Detail policy editor only offers allowed execution identities plus the profile’s current identity for review/narrowing when outside policy.
- Behavior: Server create/update still reject disallowed execution identities with safe `global_policy_violation` responses.
- Behavior: Preset availability, Custom capability switching, destructive opt-in, experiment expiry, broadening confirmation/rotation, and Outside global policy notices remain unchanged.
- Behavior: No response, rendered markup, audit record, or test fixture leaks Prism developer tokens, token hashes, peppers, Slack credentials, or Slack payloads.

## Test plan

- Existing tests to keep green:
  - `npm test` and preferably `npm run build` after implementation.
  - `src/server/token-profiles/global-policy.test.ts`, `service.test.ts`, `global-policy-store.test.ts`.
  - `app/v1/prism/token-profiles/route.test.ts`, `app/v1/prism/token-profiles/[profileId]/policy/route.ts` coverage via route tests.
  - `app/token-profile-form.test.ts`, `app/token-profiles-panel.test.tsx`, `app/token-profile-detail-panel.test.tsx`, `app/token-profile-policy-options.test.ts`.
  - `app/admin/token-profile-policy/page.test.tsx` and `app/v1/prism/admin/token-profile-policy/route.test.ts`.
- New tests to add before/with implementation:
  - Form: create modal serializes `executionIdentity` from `FormData` and retains fallback behavior if omitted.
  - Create panel: renders allowed/default execution identities from `policyOptions`; excludes or disables disallowed identities; copy updates away from hard-coded automatic.
  - Detail panel: filters/disables execution identity options based on `policyOptions.executionIdentities.allowed`, while preserving visible current outside-policy identity.
  - Server/service or route: explicit disallowed execution identity on create/update is rejected with `global_policy_violation` and no secret material; default from global policy is accepted when caller omits identity.
  - Policy DTO: projection includes execution identity allowed/default values from global policy.
- Live proof required:
  - Run app against local migrated DB, set global policy to allow/default `user` while disallowing `automatic`, open create modal, verify `User-backed` is default/selectable and create succeeds without submitting `automatic`.
  - On an existing `automatic` profile after tightening policy, verify detail shows Outside global policy, rotation remains blocked, the current identity is visible for review, and selecting an allowed identity can narrow/update.
  - Capture browser screenshot or DOM proof plus network response evidence; confirm console has no errors and no token material appears except the copy-once token field immediately after creation/rotation.

## Risk assessment

- Risk: Using controlled Select state incorrectly could desync form submission from visible selection. Mitigation: add request-body/form tests and render tests around selected defaults.
- Risk: Hiding the current identity for an outside-policy profile could trap users or cause accidental changes. Mitigation: include current identity as visible/current even if marked blocked, and allow narrowing to policy-allowed identities.
- Risk: Over-eager UI filtering could break policy preset/capability behavior. Mitigation: change execution identity affordances only and keep existing preset/capability handlers.
- Risk: Assuming client filtering is enforcement could leave API bypasses. Mitigation: keep and extend service/route tests for server-side rejection.
- Risk: Copy changes or failed create handling could leak/corrupt copy-once token semantics. Mitigation: preserve existing create success path and secret canary assertions.

## Decision confidence

- Confidence: high
- Reasons:
  - Server ownership and enforcement points already exist and are wired through pages/routes.
  - Safe client DTO already exposes the exact missing execution identity policy data.
  - The observed gap is localized to create/detail UX and create-modal request serialization.
- Open questions:
  - Exact UX copy/labels for a current identity that is now disallowed should be chosen during implementation, but it should preserve review/narrowing and not imply current token revocation.
