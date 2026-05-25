# Architecture Integration Brief: prism-website-guided-token-profile-management

## Existing ownership

- Package/component/module/library: `app/page.tsx` owns dynamic server composition and only renders `TokenProfilesPanel` for linked Slack sessions; `app/token-profiles-panel.tsx` owns Token profile client state, create/rotate/revoke/policy form submission, copy-once token display, and profile list rendering.
- Current owner rationale: the Token profile APIs already exist under `app/v1/prism/token-profiles/**/route.ts`, but the website behavior requested in issue #19 is client interaction and presentation. Server policy semantics are owned by `src/server/token-profiles/service.ts`, `presets.ts`, `execution-identity.ts`, and the Postgres store, not by the website component.
- Source evidence: `app/page.tsx` maps `listTokenProfiles` results into `TokenProfileSummary` and passes them to `TokenProfilesPanel`; `app/token-profiles-panel.tsx` calls the existing endpoints (`POST /v1/prism/token-profiles`, `/rotate`, `/revoke`, `/policy`) and stores `profiles`, `developerToken`, `error`, `submitting`, and `actionProfileId` locally. `app/ui.tsx` owns shared primitives (`Button`, `Panel`, `StatusBadge`, `Notice`, `SummaryMetric`, `cx`). `app/globals.css` owns website design tokens and Token profile classes.

## Existing interaction model

- User/system behaviors that already exist:
  - Token profiles are available only after Slack is linked; `reauth_required` still allows profile management but warns that Slack calls need reauth.
  - Creation submits `name`, `intendedUse`, `preset`, `executionIdentity`, top-level `destructive`, optional `experiment`, and `custom` only when `preset === "custom"`.
  - Successful create/rotate/policy broadening may return `developerToken`, which is shown once in client state and cleared on the next create/rotate/revoke/policy action.
  - Existing profiles display preset, execution identity, token status, expiry, last used, optional overlap expiry, and optional revoked timestamp.
  - Rotation submits only `{ overlap }`; revoke submits no body; policy update submits existing name/intended use plus new preset, execution identity, experiment, and `confirmBroadening`.
  - Server semantics: broadening requires rotation/confirmation, narrowing applies immediately, destructive is opt-in, experiments expire at 24h/7d, destructive profiles expire after 30 days, non-read-only profiles after 90 days, read-only profiles can have no expiry.
- Behaviors that must remain unchanged:
  - Do not make developer tokens retrievable from list/status/profile metadata; plaintext token may appear only in the immediate create/rotate/policy-broadening success response and UI state.
  - Do not change endpoint paths, methods, payload field names, response handling, `Cache-Control: no-store`, audit behavior, or request-id behavior.
  - Preserve `formatUtcDate`/`formatUtcDateTime` deterministic UTC rendering to avoid hydration drift.
  - Preserve keyboard-accessible controls, visible labels, disabled states, and no hover-only affordances.
- Runtime or UX evidence: baseline `npm test` passes (44 files, 117 tests); baseline `npm run build` passes on Next 16.2.6. `npm test -- --runInBand` is not valid for Vitest 4 and fails with unknown option. Issue #19 is open and blocked by completed #18; HEAD is `53a2daa feat: redesign Prism website shell`.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep React client state in `TokenProfilesPanel` (`useState`, `onSubmit`, native `FormData`, `fetch`) and use conditional rendering/progressive disclosure rather than moving interaction into `page.tsx` or new server state.
  - Use existing `Button`, `Panel`, `StatusBadge`, `Notice`, and `cx` primitives; extend only local CSS classes in `app/globals.css`.
  - Use semantic native form controls: `fieldset`/`legend`, labelled inputs/selects/checkboxes, `aria-describedby`, `role="status"`/`aria-live` for copy-once and success/error states, and normal disabled button states.
  - Use browser overflow handling already proven in `.copy-once code { overflow-wrap: anywhere; }`; a copy helper may use `navigator.clipboard.writeText` only as progressive enhancement and must not replace visible copy-once token text.
  - Use `formatUtcDate` and `formatUtcDateTime` for all displayed timestamps.
- Relevant docs or library capabilities:
  - React/Next support client components with local state for interactive islands under server-rendered pages. This matches the current `"use client"` owner.
  - Native forms/FormData keep payload compatibility clear and avoid introducing a parallel form state machine.
  - Current dependencies do not include `@testing-library/react`, `@testing-library/user-event`, `jsdom`, or `happy-dom`; existing component tests use `react-dom/server` static markup and cannot exercise clicks, async fetch, or loading transitions.
- Existing examples in this codebase: `app/slack-status-panel.tsx`, `app/activity-audit-panel.tsx`, and `app/ui.test.tsx` follow SSR/static-markup tests; route tests cover API secret-leakage and semantics; `app/design-system.test.ts` guards no inline styles, OKLCH tokens, and no notice side-stripes.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate Token profile policy logic in the client. Explain presets/identity in UI copy, but let `src/server/token-profiles/presets.ts` and `service.ts` remain authoritative.
  - Do not create alternate endpoints, server actions, local storage/session storage persistence, cache layers, or a second profile store.
  - Do not bypass `app/page.tsx` as the server composition owner or fetch profile lists in the client to replace `initialProfiles`.
  - Do not bypass shared UI primitives or OKLCH token classes with inline styles/ad hoc components.
  - Do not bypass `formatUtcDate*` date helpers.
  - Do not introduce a modal-first workflow unless it also handles focus trapping, escape/close, scroll locking, and re-entry; a modal is not justified for the primary creation path because the design docs prefer a task-focused workspace and progressive form.
- Shortcuts or parallel paths to avoid:
  - Avoid keeping separate client copies of capability maps, expiry calculations, broadening classification, or revoked/expired status logic.
  - Avoid hiding token copy behind browser clipboard only; visible copy-once text must remain available.
  - Avoid conditional UI that disables or omits submitted custom/destructive fields when they are semantically required.
- Invariants:
  - Plaintext `prism_dev_` appears only after successful create/rotate/policy broadening and is cleared when another action begins.
  - Existing create/rotate/revoke/policy endpoints and payload compatibility remain intact.
  - Reauth warning remains visible when `slackStatus === "reauth_required"`.
  - Empty profile list, error, loading/disabled, success/copy-once, revoked, expired, missing, overlap, last-used, and no-expiry states remain intentional and labelled.

## Integration plan

- Insert the change at:
  - Primary implementation in `app/token-profiles-panel.tsx`, preserving it as the client interaction owner.
  - Styling in `app/globals.css`, reusing design tokens and existing `.token-form`, `.profile-list`, `.profile-card`, `.profile-actions`, `.copy-once` areas or replacing them with same-scope Token profile classes.
  - Tests in `app/token-profiles-panel.test.tsx`; optionally route tests only if payload compatibility changes are intentionally added.
- Why this is the correct integration point:
  - Issue #19 is a guided management UX over existing APIs. `TokenProfilesPanel` already centralizes client state and endpoint calls, so redesigning there avoids a parallel path around server/API ownership.
  - Local pure helpers/constants are safe for labels, descriptions, form option metadata, status labels, and view formatting. Local presentational subcomponents are safe if they receive state/handlers from `TokenProfilesPanel` and do not fetch or own server state.
  - A progressive structured form using sections/fieldsets/cards keeps creation in the main workflow, avoids modal accessibility/focus complexity, and aligns with `PRODUCT.md`/`DESIGN.md` guidance against raw debug forms.
- Alternatives considered and rejected:
  - Modal wizard: rejected as first implementation because creation is a primary workspace task, not a secondary interrupt; modal accessibility would add avoidable risk.
  - Server action rewrite: rejected because existing REST routes and route tests already define semantics and Local tool/API compatibility.
  - Client-side capability-map builder: rejected because it would duplicate policy ownership and drift from server logic.
  - Adding a full interaction test stack as the first move: not required for static visible-state coverage, but acceptable if the implementer decides loading/error/copy button behavior must be tested through real DOM events.

## Regression checklist

- Behavior: create submits the same compatible payload shape, including `custom` only for custom preset and destructive opt-in fields that preserve server semantics.
- Behavior: rotate submits selected overlap and displays the returned replacement token once; old token overlap/revoked status remains displayed from returned profile metadata.
- Behavior: revoke calls the existing revoke endpoint, returns no developer token, clears visible token material, and updates the profile revoked state.
- Behavior: policy update preserves existing name/intended use, handles broadening confirmation, and displays a returned developer token only when the server returns one.
- Behavior: token material is never rendered in initial profile lists, tests, logs, or metadata; no `tokenHash`, Slack token, pepper, `client_secret`, or `access_token` leaks.
- Behavior: reauth-required, empty, loading/disabled, error, success/copy-once, copy guidance, expired/missing/revoked/active status, no-expiry, last-used, overlap, and revoked timestamps are visible and understandable.
- Behavior: `PRODUCT.md`/`DESIGN.md` constraints remain true: professional light workspace, restrained violet accent, no raw debug form, no side-stripe notices, no inline styles, no hover-only controls, WCAG-oriented labels/focus/touch targets.
- Behavior: production build passes and existing route/service/preset/identity tests remain green.

## Test plan

- Existing tests to keep green:
  - `npm test`
  - `npm run build`
  - `app/token-profiles-panel.test.tsx`
  - `app/design-system.test.ts`
  - `app/ui.test.tsx`
  - `app/v1/prism/token-profiles/route.test.ts`
  - `src/server/token-profiles/{service,presets,execution-identity,developer-token,local-tool-status,local-tool-capabilities,method-policy}.test.ts`
- New tests to add before/with implementation:
  - Static rendering tests for guided creation structure: headings/fieldsets/step labels, preset explanations, execution identity explanations, experiment/destructive guidance, custom capability labels, and primary CTA copy.
  - Static rendering tests for profile state coverage: empty list, reauth warning, active/expired/missing/revoked statuses, no expiry, last used, overlap, revoked timestamp, consistent rotate/revoke/policy button labels.
  - Static no-secret-leakage assertions across all rendered states, including sample initial profiles that contain metadata but no plaintext token.
  - If custom policy controls are added, route or helper tests should confirm the submitted payload remains compatible with existing route field names (`custom`, `destructive`, `confirmBroadening`) and does not alter API semantics.
  - If a clipboard copy button or richer loading/error interactions are added, either add a DOM test environment (`@testing-library/react` plus `jsdom`/`happy-dom`) or extract narrowly scoped pure helpers for request-body construction and state labels; current `react-dom/server` tests cannot click buttons, await fetch, or observe loading transitions.
- Live proof required:
  - Run `npm test` and `npm run build`.
  - Start the app with `npm run dev -- --hostname 0.0.0.0 --port 3732` or the existing `npm run dev` script and capture a browser screenshot/accessibility snapshot of the Token profiles panel in at least empty/with-profile states if feasible.
  - In live QA, verify copy-once token area wraps long token text, profile actions are keyboard reachable, disabled/loading labels are visible during slow/stubbed requests if feasible, and no console errors appear.

## Risk assessment

- Risk: Hiding custom capability controls until `preset === "custom"` can accidentally omit required checkbox values or send `custom` for non-custom profiles. Mitigation: preserve `FormData` payload logic and add request-body helper tests if logic is refactored.
- Risk: Destructive opt-in has two server paths (`input.destructive` for `full_slack_bridge`, `input.custom.destructive` for custom). Mitigation: UI copy can present one destructive decision, but submission must map it to the existing fields correctly.
- Risk: Policy update currently does not expose custom capability/destructive controls even though the route accepts them; adding them may create new broadening/narrowing paths. Mitigation: if added, rely on the existing policy endpoint and broadening confirmation; do not duplicate classification in the client.
- Risk: Copy-to-clipboard enhancement could create false confidence or leak token into logs/tests. Mitigation: visible token remains the source of truth, clipboard result is a transient status only, and tests assert no token canary appears in initial states.
- Risk: Splitting into subcomponents could introduce hidden state or duplicate fetch handlers. Mitigation: keep network handlers and profile state in `TokenProfilesPanel`; subcomponents are presentational and receive callbacks.
- Risk: Broader CSS changes could break the professional shell or design guard. Mitigation: limit CSS to Token profile classes, use existing tokens, and run design-system/build tests.
- Risk: Adding DOM testing dependencies increases package surface. Mitigation: only add if event-level behavior cannot be adequately covered with existing route/static tests.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership boundaries are clear: server API/policy semantics are already well tested, and issue #19 is primarily a client presentation/interaction redesign within the existing `TokenProfilesPanel` owner.
  - Existing primitives, CSS tokens, date helpers, and route/service tests provide stable extension points and regression coverage.
  - Baseline `npm test` and `npm run build` pass; the only failed validation was an invalid Vitest flag, not a project failure.
- Open questions:
  - Whether the implementer should add a DOM testing stack for true loading/click/copy interaction coverage, or keep this slice dependency-free with static markup plus route/helper tests.
  - Whether policy update should expose full custom capability/destructive controls now, or keep update narrower while making current preset/identity/expiry/broadening semantics clearer. Either path must preserve the existing policy endpoint payload contract.
