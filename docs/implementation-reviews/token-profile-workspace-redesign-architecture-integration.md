# Architecture Integration Brief: token-profile-workspace-redesign

## Existing ownership

- Package/component/module/library:
  - `app/page.tsx` owns dynamic homepage composition, session-cookie lookup, Slack website status, server-side Token profile summary loading, and recent audit loading.
  - `app/token-profiles-panel.tsx` currently owns the linked-session Token profile client island: create form, list rendering, local `profiles` state, copy-once developer-token display, and create/rotate/revoke/policy fetch handlers.
  - `app/token-profile-form.ts` owns browser form-to-API payload shaping for create and policy update.
  - `app/activity-audit-panel.tsx`, `src/server/audit/postgres-store.ts`, and `src/server/audit/presentation.ts` own Metadata-only audit rendering, persistence reads, and browser-safe summary shaping.
  - `app/v1/prism/token-profiles/**/route.ts`, `src/server/token-profiles/service.ts`, and `src/server/token-profiles/store.ts` own Token profile lifecycle API semantics, validation, copy-once Prism developer-token issuance, revocation, rotation, broadening rules, and Postgres persistence.
  - `components/ui/*`, `app/ui.tsx`, `app/globals.css`, `radix-ui`, and shadcn-generated local primitives own the current UI substrate.
- Current owner rationale:
  - The requested redesign is a website workspace/data-placement change over existing Token profile lifecycle and audit systems. It should not move policy, token issuance, token verification, Slack credential custody, or audit retention into UI code.
  - Current Next pattern is server-rendered data composition in `app/page.tsx` and client-side mutation through existing route handlers from `TokenProfilesPanel`.
- Source evidence:
  - `app/page.tsx:22-28` reads Slack status, Token profiles, and audit server-side; `app/page.tsx:134-164` uses `listTokenProfiles` and `listRecentActivityForSession` directly rather than calling HTTP route handlers.
  - `app/token-profiles-panel.tsx:73-168` owns client state and lifecycle fetches; `app/token-profiles-panel.tsx:169-432` currently renders inline create/list/manage sections.
  - `app/v1/prism/token-profiles/route.ts:36-69`, `[profileId]/rotate/route.ts`, `[profileId]/revoke/route.ts`, and `[profileId]/policy/route.ts` expose the API boundaries.
  - `src/server/token-profiles/service.ts:103-292` owns create/list/revoke/rotate/policy behavior and copy-once token returns.
  - `src/server/token-profiles/store.ts:31-39` lists active profile records; `store.ts:110-159` revokes developer tokens without hard-deleting the Token profile.

## Existing interaction model

- User/system behaviors that already exist:
  - Unlinked users see a homepage setup state with Connect Slack; linked users see `TokenProfilesPanel`; `reauth_required` still permits profile management with a warning.
  - Create currently submits name, intended use, access preset, execution identity, destructive/custom flags, and optional experiment expiry, then shows the returned Prism developer token once in local component state.
  - Rotate returns a replacement Prism developer token once; policy broadening requires confirmation and may also return a replacement once; revoke returns no token material.
  - List/profile metadata includes developer-token status metadata only (`active`, `expired`, `revoked`, `missing`, timestamps); plaintext Prism developer tokens are never listed or retrievable.
  - Recent audit is session-scoped, metadata-only, retention-filtered, capped, and rendered through an explicit safe summary.
- Behaviors that must remain unchanged:
  - Slack credentials, token hashes, peppers, OAuth secrets, Slack content/payloads, search queries, file contents, and Prism developer tokens must not be exposed except the immediate copy-once create/rotate/policy-broadening success token.
  - Existing lifecycle endpoints, request fields, `Cache-Control: no-store`, request-id headers, audit writes, broadening-rotation semantics, and server-side validation must remain authoritative.
  - Slack reauth should preserve Token profile management while clearly marking Access as unavailable for local-tool Slack use.
  - Remove access must revoke the current Prism developer token and preserve Token profile/audit metadata; it must not hard-delete profile rows or audit rows.
- Runtime or UX evidence:
  - Focused baseline passed: `npm test -- --run app/token-profiles-panel.test.tsx app/token-profile-form.test.ts app/activity-audit-panel.test.tsx app/v1/prism/token-profiles/route.test.ts src/server/token-profiles/service.test.ts src/server/token-profiles/store.test.ts src/server/audit/postgres-store.test.ts --reporter=dot` => 7 files, 26 tests passed.
  - Production baseline passed: `npm run build` compiled all current app/API routes successfully.
  - Runtime check found port 3732 already served the app; `GET /` returned 200 with current unlinked homepage text, and `/v1/prism/health` returned `{"service":"ok","database":"ok"}`.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep initial page reads in server components using `cookies()`, `database`, `createPostgresTokenProfileStore`, `listTokenProfiles`, `createPostgresActivityAuditStore`, and presentation mappers, matching `app/page.tsx`.
  - Keep lifecycle mutations on the existing route handlers and service/store methods; client components should call `/v1/prism/token-profiles`, `/rotate`, `/revoke`, and `/policy` rather than introducing server actions or alternate APIs.
  - Add a detail route under the App Router, e.g. `app/token-profiles/[profileId]/page.tsx`, with server-side profile/audit loading and a focused client component for rotate/policy/remove interactions.
  - Reuse `TokenProfileSummary`, payload helpers in `app/token-profile-form.ts`, `ActivityAuditPanel` or a profile-scoped variant fed by `ActivityAuditSummary`, `formatUtcDate*`, and `app/ui.tsx` primitives.
  - Use existing shadcn/Radix conventions in `components/ui/*`; `radix-ui` is installed and exports `Dialog.Root` and `Popover.Root` (verified by Node import). No new dialog/popover package is needed, but local `components/ui/dialog.tsx` / `popover.tsx` wrappers should follow existing generated primitive style if needed.
- Relevant docs or library capabilities:
  - Next App Router supports dynamic nested server pages and colocated client islands; current `app/page.tsx` already marks `dynamic = "force-dynamic"` for session-owned data.
  - Radix Dialog provides focus trapping, escape handling, portal, and accessibility primitives, so modal create/remove confirmation should use Radix/shadcn-style wrappers rather than hand-rolled focus management.
  - `prism_activity_audit` already has `prism_activity_audit_profile_recent_idx` on `(token_profile_id, occurred_at DESC)`, which supports profile-specific audit reads.
- Existing examples in this codebase:
  - Local UI primitives import from `radix-ui` directly (`components/ui/select.tsx`, `radio-group.tsx`, `checkbox.tsx`, `button.tsx`).
  - Existing static component tests use `renderToStaticMarkup`; route/store/service tests verify no-secret and API semantics.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate Token profile policy construction, broadening classification, expiry rules, developer-token hashing/issuance, or token-status validation in UI code.
  - Do not add a parallel Token profile store, client-side profile cache as source of truth, local storage/session storage persistence, server actions, or new lifecycle endpoints for existing create/rotate/revoke/policy behavior.
  - Do not call Next route handlers from server components for internal reads; use the existing service/store layer like `app/page.tsx`.
  - Do not hand-roll modal accessibility when `radix-ui` is available; do not bypass `components/ui`/`app/ui` design primitives with one-off inline-styled controls.
  - Do not change Slack OAuth/credential custody, Slack forwarding, local-tool status/capabilities, method policy, rate limits, audit recording, or audit retention for a website workspace redesign.
- Shortcuts or parallel paths to avoid:
  - Do not filter profile-specific audit from a global recent-activity list in the browser; it is incomplete and scales incorrectly.
  - Do not hard-delete or mark `token_profiles.status = 'revoked'` merely to hide from the homepage unless product explicitly changes detail/audit preservation semantics.
  - Do not expose current/revoked developer tokens in profile detail, HTML, tests, logs, clipboard helpers, or JSON list responses.
- Invariants:
  - Access status means "can the Local tool use Slack through Prism right now": developer token usable plus Slack connection/identity not blocking; at minimum revoked/expired/missing developer-token metadata and `reauth_required` must not be labelled as usable access.
  - Homepage active list is small (0-12), no search/filter/pagination in core flow, row focused on name + Access status + compact Remove access.
  - Detail page ordering: lifecycle actions first, then policy configuration, then profile-specific Metadata-only audit/events.
  - Remove access revokes current Prism developer token, hides from default active list, and preserves metadata/audit.

## Integration plan

- Insert the change at:
  - `app/page.tsx`: reshape homepage composition around a clean active Token profile list. Continue server-side `listTokenProfiles`, but pass only default-active/access-usable summaries to the homepage list. Keep unlinked/reauth messaging and Slack status ownership here.
  - `app/token-profiles-panel.tsx` or a new same-scope client component: split current all-in-one panel into a homepage active-list/create-modal owner and smaller reusable lifecycle/policy client pieces. Keep current fetch handlers/payload helpers as the mutation path.
  - New `app/token-profiles/[profileId]/page.tsx`: server-side detail page that uses `cookies()` + `listTokenProfiles` (small 0-12 domain, includes revoked-token metadata) to find the selected profile and render not-found/unauth states using existing patterns. Mutations still call existing routes.
  - `src/server/audit/postgres-store.ts`: extend `ActivityAuditStore` with `listRecentActivityForTokenProfile({ sessionToken, profileId, now, limit })`, filtering by current session user, `a.token_profile_id`, retention, and bounded limit. Add route support only if a client refresh API is needed; initial detail render should use store directly.
  - `app/activity-audit-panel.tsx`: reuse as a profile-scoped panel if copy can be parameterized, or create a thin profile-specific wrapper that still accepts `ActivityAuditSummary[]` and uses the same explicit field whitelist/redaction behavior.
  - `components/ui/dialog.tsx` and optionally `components/ui/popover.tsx`: add generated-style wrappers over `radix-ui` primitives only if the modal/confirmation implementation needs them. Prefer Dialog for create and remove confirmation; Popover only if confirmation is truly non-modal and accessibility requirements are met.
- Why this is the correct integration point:
  - It matches existing ownership: `page.tsx` for server reads/placement, client components for browser interactions, route handlers/service/store for mutations, audit store for scoped audit queries.
  - It avoids a parallel path around policy/token/audit systems while allowing the UX to change from an inline management dashboard to homepage list + detail page.
  - Server-side profile detail data access through stores mirrors current `app/page.tsx` and avoids internal HTTP calls, duplicate auth handling, and route-handler response parsing.
- Alternatives considered and rejected:
  - Client-side filtering of recent audit: rejected because `/v1/prism/activity?limit=20` can omit older entries for the selected profile when other profiles have newer activity, and it transfers unrelated audit data to the browser.
  - Detail page calling existing route handlers over HTTP: rejected because current Next pattern uses service/store directly in server components; internal HTTP adds a parallel auth/error/cache path.
  - Hand-rolled modal/popover primitives: rejected because `radix-ui` is already installed and current UI components use it.
  - Changing revoke endpoint to hard-delete or revoke profile status: rejected because domain says Remove access preserves audit/profile metadata; homepage hiding can be a presentation filter over developer-token access status.

## Regression checklist

- Behavior: Homepage active list shows 0-12 default-active Token profile summaries without search/filter/pagination and with row click-through to detail.
- Behavior: Access status correctly distinguishes usable, reauth required, expired, revoked, and missing developer-token states; reauth is not presented as currently usable Slack access.
- Behavior: Add/Create opens a focused modal with only name, intended use, access preset, safe execution identity/expiry defaults, and copy-once success inside the modal.
- Behavior: Create/rotate/policy broadening show Prism developer tokens once only; no list/detail/audit response renders retrievable plaintext tokens.
- Behavior: Remove access uses compact confirmation, calls existing revoke endpoint, clears any visible token, hides the profile from homepage active list, and preserves detail/audit access.
- Behavior: Detail page shows lifecycle actions before policy configuration before profile-specific metadata-only audit/events.
- Behavior: Existing route methods, payloads, no-store headers, request IDs, audit writes, policy broadening rules, and Slack credential custody remain unchanged.
- Behavior: Metadata-only audit still excludes Slack payload/content, token material, token hashes, peppers, OAuth secrets, authorization material, and Slack credentials.
- Behavior: Keyboard/focus behavior for Dialog/confirmation is accessible; no hover-only affordances and no color-only statuses.
- Behavior: Build, full test suite, and existing no-secret canary tests remain green.

## Test plan

- Existing tests to keep green:
  - `npm test` and `npm run build`.
  - `app/token-profiles-panel.test.tsx`, `app/token-profile-form.test.ts`, `app/activity-audit-panel.test.tsx`, `app/ui.test.tsx`, `app/design-system.test.ts`, `app/website-overview.test.ts`.
  - `app/v1/prism/token-profiles/route.test.ts`, `app/v1/prism/activity/route.test.ts`.
  - `src/server/token-profiles/{service,store,presets,execution-identity,developer-token,local-tool-status,local-tool-capabilities,method-policy}.test.ts`.
  - `src/server/audit/{activity,postgres-store}.test.ts` and Slack forwarding no-content/no-secret tests.
- New tests to add before/with implementation:
  - Homepage static/component tests for clean active list: empty state, 0-12 list copy, name + Access status only, row link target, compact Remove access trigger, no search/filter/pagination controls, no secret canaries.
  - Create modal tests for visible fields only (`name`, `intendedUse`, `preset`), safe hidden/default payload values for `executionIdentity` and expiry/experiment, copy-once success copy, and modal no-secret initial rendering. If real open/close/focus behavior is implemented, add a DOM environment or isolate pure state/helpers; current static markup tests cannot click.
  - Detail page/component tests for lifecycle-first ordering, rotate/refresh/copy-once outcomes, policy section after lifecycle, profile-specific audit after policy, and no plaintext token material in initial detail HTML.
  - Store tests for `listRecentActivityForTokenProfile`: hashes session token, scopes by current session user, filters `token_profile_id`, filters retention, bounds limit to 1-50, orders by `occurred_at desc`, and does not select payload/secret columns.
  - Route/client tests as needed for Remove access hiding: existing revoke API remains unchanged; homepage client state should remove revoked profiles from the active list rather than rendering a revoked active row.
- Live proof required:
  - Run `npm test` and `npm run build` after implementation.
  - Start or use local dev server on port 3732; capture homepage and detail page browser screenshots/accessibility snapshots for unlinked, empty linked, active profile, create-modal copy-once result, remove-access confirmation, hidden-after-revoke, and profile detail audit states where feasible.
  - Use browser console/network evidence to verify no console errors, no plaintext token in list/detail/audit fetches, and route responses keep `Cache-Control: no-store`.

## Risk assessment

- Risk: Filtering homepage active profiles only in client state could drift from server-rendered active list after refresh. Mitigation: centralize an `isHomepageActiveProfile(profile, slackStatus)` helper used by both server summary mapping and client post-revoke state updates.
- Risk: `listProfiles` currently returns Token profiles whose current developer token is revoked because `token_profiles.status` remains `active`; this conflicts with the new default active-list language. Mitigation: do not change store semantics broadly; apply homepage active-list hiding based on developer-token/access status, and let detail lookup still find preserved revoked profiles.
- Risk: Profile-specific audit via client-side filtering would be incorrect once global recent activity is dominated by other profiles. Mitigation: add store-level scoped query using the existing profile audit index.
- Risk: Create modal could accidentally drop required payload defaults or broaden access. Mitigation: keep `buildCreateTokenProfileRequestBody` as the payload owner, set safe defaults (`automatic`, no experiment expiry unless product chooses otherwise, least-privilege preset default), and test the resulting JSON.
- Risk: Adding Dialog wrappers may introduce hydration/focus issues. Mitigation: follow existing shadcn/Radix wrapper style, keep modal state local to client component, and add live browser QA.
- Risk: Detail page may accidentally expose developer-token metadata as if it were copyable secret material. Mitigation: label statuses/timestamps clearly and reserve copy-once code block only for immediate mutation responses.
- Risk: Policy UI currently sits inline with rows and may rely on current profile metadata shape. Mitigation: move presentation, not semantics; keep policy payload helper and existing broadening endpoint behavior intact.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership boundaries are clear and already tested: server components read through stores, client components mutate through route handlers, services/stores own token lifecycle, and audit owns metadata-only reads.
  - Current dependencies already provide Radix Dialog/Popover primitives; no new modal library is needed.
  - Baseline focused tests, production build, and runtime health/homepage checks passed.
  - The main code/docs conflict has a straightforward non-invasive resolution: hide revoked/non-usable profiles from the homepage active list while preserving `listProfiles`/detail/audit metadata.
- Open questions:
  - Whether the detail route should remain accessible for revoked-token profiles via direct URL after Remove access. The domain says preserve metadata/audit, so this brief recommends yes, with a non-usable Access status.
  - Whether policy configuration on the detail page should initially expose every existing custom/destructive option or keep the current form semantics while reorganizing layout. Either path must preserve existing payload/server behavior.
  - Whether "refresh" in lifecycle actions means rotate with overlap, local-tool status refresh, or re-fetch detail data. Implementation should avoid inventing a new lifecycle API unless product clarifies that existing rotate/status paths are insufficient.
