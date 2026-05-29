# Architecture Integration Brief: preset-checkbox-templates

## Existing ownership

- Package/component/module/library:
  - Domain semantics are owned by `CONTEXT.md`: a Policy preset is a named capability template that fills Token profile capability checkboxes; selecting a preset applies checkbox state, and manual checkbox changes make the policy Custom (`CONTEXT.md:71-78`). Global Token profile policy provides deployment-wide defaults and maximums, while Outside global policy continues existing tokens but blocks broadening/rotation/reissue until narrowed (`CONTEXT.md:83-89`, `:127`).
  - Preset-to-capability truth is server-owned by `src/server/token-profiles/presets.ts`. `buildTokenProfilePolicy` maps `read_only`, `messages_only`, `full_slack_bridge`, and `custom` inputs to `capabilityMap.actions`, `surfaces`, `executionIdentity`, experiment, mutation, and expiry (`presets.ts:68-143`).
  - Global policy ownership now exists from issue #35 in `src/server/token-profiles/global-policy.ts` and `global-policy-store.ts`: seeded defaults/maxima, safe reason codes, parsing, request validation, outside-policy classification, and rotation-overlap validation (`global-policy.ts:97-224`, `:226-264`; `global-policy-store.ts:43-99`).
  - Token profile create/update/rotate enforcement is owned by `src/server/token-profiles/service.ts`: create/update apply global defaults, call `buildTokenProfilePolicy`, validate against global policy, preserve broadening confirmation, and return copy-once developer tokens only for create/confirmed broadening/rotation (`service.ts:126-187`, `:317-399`).
  - Website create UI is owned by `app/token-profiles-panel.tsx`; detail Policy editor is owned by `app/token-profile-detail-panel.tsx`; form body shaping is currently centralized in `app/token-profile-form.ts` (`token-profiles-panel.tsx:45-67`, `:188-209`; `token-profile-detail-panel.tsx:99-123`, `:334-373`; `token-profile-form.ts:24-61`).
  - Route contracts for create/update/rotate are owned by `app/v1/prism/token-profiles/**/route.ts`, which parse JSON, call service functions, map `global_policy_violation`, `outside_global_policy`, and `rotation_required`, and preserve no-store/request-id responses (`route.ts:38-73`; `policy/route.ts:17-58`; `rotate/route.ts:17-44`).
- Current owner rationale:
  - The visible checkbox UI must reflect server capability semantics, but the server service remains the enforcement source of truth. UI may present templates and disabled/explained choices, but must not become the only global-policy gate or construct capability maps that diverge from `buildTokenProfilePolicy`.
- Source evidence:
  - Issue #36 requires presets to visibly apply checkbox templates in create and edit, manual checkbox changes to switch to Custom, global-policy disallowed options to be disabled/explained, and submitted bodies to match visible checkbox state.
  - Current create modal only exposes preset radio options and sends `{preset, executionIdentity:"automatic", destructive:false}` without visible capabilities (`token-profiles-panel.tsx:199-209`; `token-profile-form.ts:37-45`). Current detail Policy editor shows static custom checkboxes with hard-coded defaults and says they are “Used only when the Policy preset is Custom,” so preset selection is not visible checkbox templating (`token-profile-detail-panel.tsx:347-367`).

## Existing interaction model

- User/system behaviors that already exist:
  - Homepage create opens a modal, posts to `/v1/prism/token-profiles`, then displays the Prism developer token once and blocks closing until the user confirms it was copied (`token-profiles-panel.tsx:134-185`).
  - Detail policy updates post to `/v1/prism/token-profiles/{id}/policy`; broadening without confirmation returns `rotation_required`, and confirmed broadening returns a replacement token once (`service.ts:375-399`; `policy/route.ts:46-51`; `route.test.ts:289-329`).
  - Outside global policy is shown in list/detail, rotation controls are disabled in detail, and server rotation/update paths block outside-policy broadening/rotation (`token-profiles-panel.tsx:254-257`; `token-profile-detail-panel.tsx:183-186`, `:217-225`; `service.ts:290-299`, `:356-374`).
  - Global policy admin UI already edits allowed presets, execution identities, maximum capabilities, expiry, experiment TTLs, and rotation overlap in `/admin/token-profile-policy`; it does not currently expose a reusable end-user-safe policy options DTO (`admin-token-profile-policy.tsx:93-180`, `:215-270`).
- Behaviors that must remain unchanged:
  - Server validation must still be authoritative for global policy; client-side disabled controls are advisory UX and must not replace `validateRequestedTokenProfilePolicy` (`service.ts:157-167`, `:364-373`).
  - Existing broadening confirmation and copy-once replacement-token behavior must remain unchanged: no token material in list/detail/settings/audit responses, no developer token returned before confirmed broadening, and no retrievable token after modal/notice closes (`token-profiles-panel.tsx:156-185`; `token-profile-detail-panel.tsx:307-325`; `route.test.ts:117-166`, `:289-329`).
  - Outside global policy must remain non-revoking for existing profiles; local tool runtime resolution continues using persisted capability maps from `store.ts`, not UI state or preset labels (`store.ts:375-423`, `:512-535`).
  - Policy update broadening/narrowing classification still compares capability maps, execution identity, and expiry; do not collapse it to preset label comparisons (`service.ts:466-511`).
- Runtime or UX evidence:
  - Current UI mismatch: create says “choose a starter policy” but shows no capability checkboxes; detail has capability checkboxes but only submits them when `policyPreset === "custom"` (`token-profiles-panel.tsx:151-205`; `token-profile-form.ts:47-61`).
  - Existing tests lock the clean active Token profile workspace, no-secret rendering, current form request body shapes, broadening confirmation, global-policy rejection, and audit behavior (`token-profiles-panel.test.tsx:6-107`; `token-profile-detail-panel.test.tsx:10-101`; `token-profile-form.test.ts:5-112`; `route.test.ts:168-189`, `:289-329`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add pure shared UI/domain helpers for preset templates near `app/token-profile-form.ts` or a new app-level file such as `app/token-profile-policy-options.ts`. The helper should derive visible checkbox templates from the same `TokenProfilePreset` names and capability booleans as `buildTokenProfilePolicy`, preferably by encoding only the UI projection (`read`, `search`, `writeMessages`, `reactions`, `filesMetadata`, `destructive`) with parity tests against `presets.ts`.
  - Extend `TokenProfileSummary` or add a dedicated prop passed from server pages with safe Global Token profile policy data needed by the UI: allowed presets, allowed execution identities, maximum action booleans, allowed experiment TTLs, defaults, and reason/help copy. Reuse `createPostgresGlobalTokenProfilePolicyStore(database).readGlobalTokenProfilePolicy()` from `app/page.tsx` and detail page; do not import stores into client components.
  - Use `CapabilityMap` already returned in route/service responses for actual detail-state rendering if it is added to the page DTO, or expose a narrowed `capabilities` UI DTO from `toTokenProfileSummary`. The current summary omits `capabilityMap`, so the detail editor cannot truthfully render actual persisted custom capability state today (`token-profile-summary.ts:3-24`, `:26-48`).
  - Keep form serialization in `app/token-profile-form.ts`, but update it so create and update bodies include `custom` matching the visible checkbox state whenever the visible preset is `custom`, and switch the preset field to `custom` before submission when any manual checkbox diverges from the selected template.
  - Use existing shadcn/Radix controls already present: `Checkbox`, `RadioGroup`, `Select`, `Label`, `Notice`, and `Button` (`token-profiles-panel.tsx:6-16`; `token-profile-detail-panel.tsx:6-18`).
- Relevant docs or library capabilities:
  - Next App Router pages already server-read policy/profile state and pass serializable props to client components (`app/page.tsx:24-30`, `:122-130`; `token-profiles/[profileId]/page.tsx:21-30`, `:79-83`). Continue this pattern for policy options.
  - Admin global policy editing uses native disabled fieldsets and checkbox controls for accessibility; end-user create/detail should provide equivalent disabled states plus explanatory text for policy-disallowed capabilities (`admin-token-profile-policy.tsx:99-160`, `:273-294`).
- Existing examples in this codebase:
  - `src/server/token-profiles/global-policy.test.ts` is the model for safe reason-code coverage and no-secret assertions (`global-policy.test.ts:67-153`).
  - `app/token-profile-form.test.ts` is the right location for request-body shape tests for visible checkbox state (`token-profile-form.test.ts:5-112`).
  - `app/token-profiles-panel.test.tsx` and `app/token-profile-detail-panel.test.tsx` are the right rendering tests for visible templates, disabled/explained options, Custom auto-selection cues, and no-secret canaries.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not replace `buildTokenProfilePolicy`, global-policy service validation, or `classifyPolicyChange` with client-only capability logic. The UI helper may mirror/display templates, but service and route layers remain the mutation boundary.
  - Do not create a second global-policy source in constants unrelated to `GlobalTokenProfilePolicy`; if the user UI needs policy maximums/defaults, read them server-side from `createPostgresGlobalTokenProfilePolicyStore` and pass a safe DTO.
  - Do not change admin auth, Slack OAuth scopes, method registry, local-tool forwarding, token hashing, audit schema, or credential custody for this slice.
  - Do not expose Prism developer tokens outside copy-once create/confirmed broadening/rotation flows, and do not include token hashes, peppers, Slack credentials, Authorization headers, or Slack payloads in new DTOs/tests/docs.
- Shortcuts or parallel paths to avoid:
  - No hidden preset-only submissions that ignore visible checkboxes. If checkboxes are visible, submitted `preset/custom/destructive` must correspond to that visible state.
  - No UI-only disabling without server errors. Disallowed options must be disabled/explained for users and still rejected by existing server validation if crafted requests bypass the UI.
  - No classifying manual checkbox changes after submit only; the visible Policy preset control must switch to Custom immediately when a capability checkbox changes.
  - No detail editor default checkboxes that assume read/search are true for every profile. Use persisted `capabilityMap.actions` or a safe capability projection so the edit UI starts from actual profile state.
  - No broadening-confirmation bypass when preset selection changes checkboxes. Template application can alter capabilities, but the existing `confirmBroadening` path must still be required for broadening.
- Invariants:
  - `read_only` template means read/search true; write/reactions/files/destructive false.
  - `messages_only` template means read/writeMessages/reactions true; search/files/destructive false.
  - `full_slack_bridge` template means read/search/writeMessages/reactions/filesMetadata true; destructive follows explicit destructive opt-in, not default-on.
  - `custom` means the checkbox state itself defines the capability booleans.
  - Global policy maxima disable or explain options, but existing outside-policy profiles remain visible/reviewable and local-tool use is not revoked solely by UI state.
  - Create/update request bodies must preserve current route shape: `name`, `intendedUse`, `preset`, `executionIdentity`, optional `experiment`, `destructive`, optional `custom`, and update-only `confirmBroadening`.

## Integration plan

- Insert the change at:
  - **Policy options DTO:** in `app/page.tsx` and `app/token-profiles/[profileId]/page.tsx`, read the effective global policy settings alongside profiles and pass a safe serializable policy-options prop to `TokenProfilesPanel` and `TokenProfileDetailWorkspace`. Include only allowed preset/identity/experiment values, maximum capability booleans, defaults, and reason/help labels.
  - **Profile capability DTO:** extend `TokenProfileSummary` or create a detail-only DTO to include `capabilities` derived from `profile.capabilityMap.actions` for `read`, `search`, `writeMessages`, `reactions`, `filesMetadata`, and `destructive`. Prefer a safe projection over passing raw `capabilityMap` to client components.
  - **Shared UI template model:** add app-level helpers for `capabilityTemplateForPreset`, `presetForCapabilityState` if exact match is desired, and `capabilityStateFromProfile`. Unit-test these helpers against server `buildTokenProfilePolicy` to avoid drift.
  - **Create modal:** replace preset radio-only UI with a controlled preset selector/radio group plus capability checkboxes. Selecting a preset applies its template. Manual checkbox changes set preset state to `custom`. Disable/explain globally disallowed presets/capabilities/identities. Submit through `buildCreateTokenProfileModalRequestBody` or a new function that serializes the controlled visible state.
  - **Detail editor:** make the Policy editor controlled. Initialize from actual profile capability projection and profile preset. Selecting a preset applies the template. Manual checkbox edits set `policyPreset` to `custom`. Keep execution identity, experiment, `confirmBroadening`, and destructive controls in the same form but ensure destructive checkbox participates consistently in the visible capability state.
  - **Routes/service:** avoid route/service changes unless the chosen UI DTO needs a new safe read endpoint. Existing create/update routes already accept `custom`, reject global policy violations, preserve no-store/request-id, and support broadening confirmation.
- Why this is the correct integration point:
  - Issue #36 is a user-facing interaction and request-shaping change. Existing server enforcement from issue #35 already protects all callers; the missing layer is a truthful controlled UI that projects server policy/preset semantics into visible controls.
  - Passing safe policy/profile projections from server pages follows current App Router ownership and avoids importing server-only stores into client components.
  - Keeping serialization in `token-profile-form.ts` preserves existing tests and route body contracts while making the visible checkbox state the input source.
- Alternatives considered and rejected:
  - **Server-only preset expansion without UI state:** rejected because acceptance requires visible checkbox templates and manual Custom switching.
  - **Client-only hard-coded global policy:** rejected because admins can change deployment policy, and service already reads durable settings.
  - **Sending raw `capabilityMap` back to update routes:** rejected because existing public route shape is preset/custom input, not arbitrary capability-map replacement; server should continue building capability maps.
  - **Adding a new `/v1/prism/token-profile-policy-options` API for this slice:** not necessary if homepage/detail pages can server-read the policy. Consider only if future non-page clients need the same safe options.
  - **Making disallowed options invisible:** rejected because acceptance says disabled or explained; hiding makes global-policy constraints harder to understand and may confuse existing outside-policy profiles.

## Regression checklist

- Behavior: Create still shows copy-once Prism developer token only after successful creation; modal close/copy confirmation behavior remains intact.
- Behavior: Detail policy broadening without `confirmBroadening` still returns `rotation_required`; confirmed broadening still returns one replacement token and updates the profile.
- Behavior: Narrowing still applies immediately, including narrowing from Outside global policy back inside policy.
- Behavior: Existing Outside global policy notices, list badge, rotation disabled state, and server-side outside-policy blocks remain unchanged.
- Behavior: Global policy disallowed presets/capabilities/execution identities/experiment TTLs are disabled or explained in UI and still rejected by service if submitted directly.
- Behavior: Submitted create/update request bodies match visible checkbox state, including Custom auto-selection and destructive opt-in.
- Behavior: No route response, client prop, test fixture, audit row, or rendered HTML leaks Prism developer tokens except the existing copy-once code field, token hashes, peppers, Slack credentials, Authorization headers, or Slack payloads.
- Behavior: Admin global policy editor and route behavior remain unchanged except for any shared label/helper import that is intentionally reused.
- Behavior: Accessibility remains intact: controls have labels, disabled states are programmatic where applicable, explanations are readable by assistive tech, and status/error messages retain role/aria-live behavior.

## Test plan

- Existing tests to keep green:
  - `npm test` for full regression, and `npm run build` before merge if implementation changes client/server boundaries.
  - `app/token-profile-form.test.ts`, `app/token-profiles-panel.test.tsx`, `app/token-profile-detail-panel.test.tsx`, and `app/v1/prism/token-profiles/route.test.ts`.
  - `src/server/token-profiles/{presets,global-policy,service,global-policy-store,store}.test.ts` to verify server policy/preset semantics are unchanged.
  - Admin policy tests under `app/admin/token-profile-policy/*.test.tsx` and `app/v1/prism/admin/token-profile-policy/route.test.ts` if any shared policy-label/options helpers are touched.
- New tests to add before/with implementation:
  - Pure helper tests: each preset template matches `buildTokenProfilePolicy(...).capabilityMap.actions`; Full Slack bridge destructive remains off until explicit opt-in; manual divergence maps to Custom.
  - Create UI render tests: create modal renders capability checkboxes reflecting selected preset; selecting/read-only vs messages-only vs full-bridge applies expected checked states; global-policy disallowed options render disabled/explained; controls have accessible labels/help text.
  - Detail UI render tests: initial checkboxes reflect actual persisted capability projection, not hard-coded defaults; outside-policy profiles show existing warning and disabled rotation; globally disallowed capabilities are explained without losing current state visibility.
  - Interaction tests if feasible with React Testing Library/user-event or existing test stack equivalent; if not currently installed, use form helper unit tests plus static-render coverage and avoid adding new testing libraries unless approved.
  - Form/request tests: create and update body builders serialize exactly the visible checkbox state; manual checkbox edits set `preset/custom`; broadening confirmation remains in update body; disallowed disabled controls cannot accidentally submit broadened capability booleans.
  - Route/service regression tests: direct crafted requests that exceed global policy continue returning `global_policy_violation`; confirmed broadening still returns copy-once token once; no-secret canaries remain absent.
- Live proof required:
  - Run `npm test` and targeted changed tests; run `npm run build` before final review if UI/server props changed.
  - Start the app with `npm run dev` against local Postgres if available, open homepage create modal, and capture browser evidence that Read-only/Messages only/Full Slack bridge update checkbox state and manual checkbox change switches to Custom.
  - Create a profile and verify the submitted network request body matches visible checkbox state and the copy-once token notice still works.
  - Open profile detail, verify actual capability state renders, selecting templates updates checkboxes, manual checkbox changes switch to Custom, and broadening still requires confirmation before a replacement token appears.
  - Tighten a harmless Global Token profile policy maximum as a global admin and verify user-facing disallowed options are disabled/explained while direct crafted requests are still server-rejected.

## Risk assessment

- Risk: UI template constants drift from server `buildTokenProfilePolicy`. Mitigation: colocate a small UI projection helper with parity tests against `presets.ts`, and keep service validation authoritative.
- Risk: Passing raw `capabilityMap` to client components exposes future internal fields or encourages clients to post arbitrary maps. Mitigation: pass a narrow capability projection only.
- Risk: Controlled checkboxes can break existing broadening confirmation by submitting a broadened Custom body unexpectedly. Mitigation: keep `confirmBroadening` unchanged, add body-shape tests, and route regression tests around `rotation_required`.
- Risk: Global policy disabled controls can hide an existing outside-policy capability, making narrowing impossible or confusing. Mitigation: distinguish “currently enabled but outside maximum” from “available to add”; show checked current state with warning/help, and allow narrowing.
- Risk: Destructive action semantics are easy to misrepresent because Full Slack bridge has most capabilities but destructive off by default. Mitigation: treat destructive as an explicit capability checkbox/opt-in and test Full Slack bridge both with and without it.
- Risk: Adding richer client props could leak settings/audit or token material. Mitigation: DTO allowlists, no-secret render tests, and reuse existing no-secret canaries.
- Risk: Static render tests may not exercise interactive Custom auto-selection. Mitigation: prefer adding interaction-capable tests if existing dependencies support it; otherwise make state transitions pure/testable and cover helper outputs thoroughly.

## Decision confidence

- Confidence: high
- Reasons:
  - The domain definition, issue #36 acceptance criteria, and current code all point to the same integration shape: make create/detail policy controls controlled by visible capability state while preserving server service enforcement.
  - Issue #35 global-policy infrastructure is already present, so this slice should consume safe policy projections rather than invent persistence or authorization.
  - Existing route/service tests already cover the most important invariants: no-secret copy-once behavior, server global-policy rejection, and broadening confirmation.
- Open questions:
  - Should the create modal expose execution identity/expiry now, or only disable/explain preset/capability constraints while keeping current automatic/no-expiry defaults? For the narrow issue #36 slice, keep current create modal defaults unless product explicitly expands create-time controls.
  - Should exact template-match after manual changes auto-select a named preset again, or should any manual checkbox change always leave Custom until the user explicitly picks a preset? The issue says manual checkbox changes immediately set Custom; prefer staying Custom until explicit preset selection.
  - Should a reusable safe policy-options endpoint be introduced for future dynamic clients, or are server-page props enough for now? Prefer server-page props for this slice.
