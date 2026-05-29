# Architecture Integration Brief: admin-console-end-to-end-qa

## Existing ownership

- Package/component/module/library:
  - **Domain language / PRD semantics:** `CONTEXT.md` owns the terms for Prism admin console, Prism admin, Global Token profile policy, Outside global policy, Policy preset, Admin action audit, Remove Slack connection, and Disconnected Prism user. Issue #39 is a verification-and-hardening gate, not a new feature slice.
  - **Admin authorization:** `src/server/admin/authorization.ts`, `src/server/admin/allowlist.ts`, `src/server/admin/postgres-store.ts`, `app/admin/page.tsx`, `app/admin/admin-shell.tsx`, and `app/v1/prism/admin/session/route.ts` own global/enterprise/team/non-admin admin decisions from the current Slack-authenticated Prism website session.
  - **Scoped user directory/detail:** `src/server/admin/user-directory.ts`, `src/server/admin/postgres-user-directory-store.ts`, `app/admin/users/**`, and `app/v1/prism/admin/users/**` own scoped listing, scoped detail, generic out-of-scope/missing outcomes, safe metadata projection, and disconnected-user retention visibility.
  - **Global Token profile policy:** `src/server/token-profiles/global-policy.ts`, `src/server/token-profiles/global-policy-store.ts`, `app/admin/token-profile-policy/**`, and `app/v1/prism/admin/token-profile-policy/route.ts` own policy schema, defaults, maxima, durable singleton settings, global-admin editing, scoped-admin read-only display, and policy-update audit.
  - **Token profile enforcement / preset-template UX:** `src/server/token-profiles/service.ts`, `src/server/token-profiles/presets.ts`, `src/server/token-profiles/store.ts`, `app/token-profile-policy-options.ts`, `app/token-profiles-panel.tsx`, `app/token-profile-detail-panel.tsx`, `app/token-profile-form.ts`, and `/app/v1/prism/token-profiles/**` own create/update/rotate/revoke/delete semantics, preset-as-visible-template behavior, copy-once Prism developer token display, broadening rotation, and Outside global policy blocks.
  - **Admin destructive actions:** `src/server/admin/token-profile-actions.ts`, `src/server/admin/slack-connection-actions.ts`, `app/admin/users/admin-token-profile-actions.tsx`, `app/admin/users/admin-slack-connection-actions.tsx`, and admin action route handlers own typed confirmation, required reason, scoped target resolution, local Prism mutations, and admin audit metadata.
  - **Metadata-only audit:** `src/server/audit/activity.ts`, `src/server/audit/postgres-store.ts`, `src/server/audit/presentation.ts`, `app/activity-audit-panel.tsx`, and migrations `0003`, `0011`, `0012`, `0013` own audit record shape, redaction boundary, retention, admin actor/reason fields, and visible audit presentation.
  - **Slack/OAuth/credential custody and Slack Web API seam:** `src/server/slack/oauth-flow.ts`, `src/server/slack/postgres-store.ts`, `src/server/slack/connection-management.ts`, `src/server/slack/web-api-client.ts`, `src/server/slack/method-registry.ts`, and `/app/v1/slack/api/[method]/route.ts` own Slack credential custody, Slack-compatible forwarding, unsupported Slack admin methods, and upstream-call boundaries.
  - **UI primitives:** `app/ui.tsx` plus existing shadcn/Radix primitives in `components/ui/*` own buttons, panels, notices, dialogs, forms, and accessible interaction patterns.
- Current owner rationale:
  - Issue #39 must prove the already-integrated package end to end. Defect fixes belong inside the existing owner that already enforces the relevant invariant; adding a new QA-only path would bypass the product semantics under test.
  - Admin authority is Prism-local and server-side. The implementation must continue to resolve admins via the allowlisted Slack user identity in the current Prism website session, then delegate scoped reads/mutations to admin services.
  - Policy enforcement belongs in the Token profile service/global-policy service, not in UI-only checks. UI states are affordances; service/route tests must prove the same denial paths.
- Source evidence:
  - `CONTEXT.md` defines the required domain boundary and acceptance terms.
  - Issue #39 states this is a final QA/review/hardening gate after #33-#38 and code changes are only for defects against established PRD #32 semantics.
  - Existing tests already cover the major owners: `src/server/admin/*.test.ts`, `app/v1/prism/admin/**/*.test.ts`, `app/admin/**/*.test.tsx`, `src/server/token-profiles/global-policy*.test.ts`, `app/token-profile-policy-options.test.ts`, `app/token-profile-form.test.ts`, `app/token-profiles-panel.test.tsx`, `app/token-profile-detail-panel.test.tsx`, and `app/activity-audit-panel.test.tsx`.
  - Baseline check during scout: `npm test -- --reporter=dot` passed (77 files, 243 tests).

## Existing interaction model

- User/system behaviors that already exist:
  - Global admins resolve to `{ kind: "global" }`, can open admin pages/APIs, see all scoped directory data, and can PATCH the Global Token profile policy.
  - Enterprise/team scoped admins resolve to their specific scope, can open admin pages/APIs, can see only users whose current or retained metadata matches scope, can inspect the Global Token profile policy as read-only, and cannot PATCH it.
  - Non-admin or scope-mismatched authenticated users receive generic denial (`401` unauthenticated, `403` forbidden) without allowlist internals.
  - Missing and out-of-scope user detail API requests both map to generic `404 { error: "not_found" }`; the user-directory service returns the same `not_found` outcome for missing and out-of-scope targets.
  - Disconnected Prism users remain list/detail-visible to scoped admins when retained user or audit metadata proves team/enterprise scope.
  - Policy presets are visible templates: choosing a named preset fills checkbox state; manual checkbox edits switch the policy to Custom except the documented destructive opt-in behavior for full bridge.
  - Existing profiles outside a stricter Global Token profile policy remain visible/usable until expiry or revocation, but `rotateTokenProfile` and non-narrowing `updateTokenProfilePolicy` return `outside_global_policy` and the UI shows Outside global policy messaging.
  - Admin revoke/delete/remove actions require exact typed confirmation (`REVOKE`, `DELETE`, `REMOVE`) and a non-empty reason <= 240 chars before mutation stores are touched.
  - Admin action audit records carry admin actor Prism user ID, Slack user ID/display name, target object metadata, request ID, status, and reason; audit builders deliberately ignore payload/secret canaries.
  - Admin Remove Slack connection deletes only Prism-local `slack_connections` after writing metadata-only audit with `upstreamCalled: false`; it does not import or call Slack OAuth clients, Slack Web API clients, token revoke, app uninstall, or Slack admin APIs.
- Behaviors that must remain unchanged:
  - Prism admin console must stay Prism-only and must not claim Slack workspace/admin authority.
  - Admin allowlist and scope checks remain server-side; no client-side admin flag, localStorage, JWT, DB role table, Slack role check, or Prism developer token auth for admin console.
  - Scoped admins must not learn about out-of-scope Prism users through directory rows, direct detail URLs, mutation responses, audit rows, IDs, counts, timing-sensitive messages, or error copy.
  - Global policy maximums/defaults must be enforced by services/routes; UI disabled controls are not sufficient.
  - Copy-once Prism developer token semantics must remain: creation/rotation may return a token once; admin directory/detail/audit must never show token material.
  - Admin destructive actions must be auditable and all-or-nothing: if audit insert fails, mutation must not occur.
  - Remove Slack connection remains a destructive local Prism reset; no Slack-side revoke/uninstall/admin behavior is allowed.
- Runtime or UX evidence:
  - Admin pages are dynamic server-rendered pages using `cookies()` and `resolvePrismAdmin`; admin APIs return no-store JSON and `X-Prism-Request-ID`.
  - Admin directory UI uses `safeConnectionText`, `displayNameWithId`, `ActivityAuditPanel`, and admin action dialogs.
  - Potential code/doc conflict to QA: `app/admin/admin-shell.tsx` still says “Admin surfaces unlock in the next slices” / “Destructive admin actions remain separate gated slices” even though #33-#38 are complete. If visible in live QA, harden this copy in `admin-shell.tsx` without changing architecture.
  - Potential acceptance nuance to QA: the direct user-detail API returns generic 404 for out-of-scope targets, but the server-rendered `/admin/users/[userId]` page currently renders `AdminAccessDenied` for any non-detail result. This does not expose target existence, but if #39 requires a literal user-facing not-found state, fix in the page owner rather than adding a parallel route.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Admin resolver: `resolvePrismAdmin({ store, allowlist, sessionToken, now })` with `createPostgresAdminIdentityStore(database)` and `loadAdminAllowlist()`.
  - Admin directory service: `listAdminUsers` and `getAdminUserDetail` with `createPostgresAdminUserDirectoryStore(database)`; keep redaction in `src/server/admin/user-directory.ts` and SQL scoping in `postgres-user-directory-store.ts`.
  - Admin policy API: `/v1/prism/admin/token-profile-policy` GET/PATCH; use `createPostgresGlobalTokenProfilePolicyStore(database)` and `parseGlobalTokenProfilePolicy`.
  - Token profile user APIs: `/v1/prism/token-profiles`, `/v1/prism/token-profiles/[profileId]/policy`, `/rotate`, `/revoke`, DELETE; use `createTokenProfile`, `updateTokenProfilePolicy`, `rotateTokenProfile`, `revokeTokenProfile`, `deleteTokenProfile`.
  - Admin token profile APIs: `/v1/prism/admin/users/[userId]/token-profiles/[profileId]/revoke` and DELETE; use `revokeAdminTokenProfile` / `deleteAdminTokenProfile`.
  - Admin Slack connection API: `/v1/prism/admin/users/[userId]/slack-connection` DELETE; use `removeAdminSlackConnection` and `createPostgresAdminSlackConnectionActionStore`.
  - Audit display: `ActivityAuditPanel` and audit presentation types; do not build a special admin-only audit renderer unless a defect is found in that component.
  - UI components: reuse `Button`, `LinkButton`, `Panel`, `Notice`, `StatusBadge`, `SummaryMetric`, Radix Dialog/Select/RadioGroup/Checkbox/Input/Textarea wrappers already used in the app.
  - QA harness: use the real Next app (`npm run dev` on port 3732), the configured Postgres/migrations scripts, Playwright/browser proof for page flows, API calls with real session cookies, SQL inspection of local DB state, and captured command logs as session artifacts rather than committed evidence.
- Relevant docs or library capabilities:
  - Next.js App Router route handlers and server pages already provide request cookies, dynamic rendering, and no-store JSON response patterns.
  - Vitest is the existing test runner; use current test patterns and do not add new tooling unless a defect requires it.
  - Postgres migrations are run by `npm run db:migrate`; Docker Postgres helper is `npm run db:up` / `npm run db:down`.
- Existing examples in this codebase:
  - `app/v1/prism/admin/session/route.test.ts` for admin decision response behavior.
  - `app/v1/prism/admin/users/[userId]/route.test.ts` for generic out-of-scope/missing detail behavior.
  - `src/server/admin/token-profile-actions.test.ts` and admin action route tests for typed confirmation/reason mutation gating.
  - `src/server/admin/slack-connection-actions.test.ts` for no Slack-side call semantics via the narrow store interface and SQL-only local deletion.
  - `src/server/token-profiles/service.test.ts`, `global-policy.test.ts`, and `/app/v1/prism/token-profiles/route.test.ts` for policy enforcement and Outside global policy blocks.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate admin authorization, load the allowlist in client code, or introduce middleware/client-only gates as the source of truth.
  - Do not bypass `src/server/admin/postgres-user-directory-store.ts` scope SQL/read model for directory/detail/mutation target checks.
  - Do not bypass `src/server/token-profiles/global-policy.ts` or `src/server/token-profiles/service.ts` with UI-only policy checks.
  - Do not bypass admin action services; typed confirmation/reason validation must occur before mutation stores and audit metadata must be passed through the existing service seams.
  - Do not bypass `insertActivityAuditRecord` / activity presentation or create a second audit table/log for QA.
  - Do not touch OAuth credential custody or Slack connection credential storage except through existing local removal stores.
  - Do not call Slack Web API, Slack OAuth revoke, `auth.revoke`, `apps.uninstall`, Slack admin methods, SCIM, or workspace membership APIs for admin Remove Slack connection.
  - Do not add new UI primitives for ordinary forms/dialogs when current Prism/shadcn primitives already cover them.
- Shortcuts or parallel paths to avoid:
  - No seeded fake “admin mode” route, mocked success UI, test-only bypass, manually edited browser state, or direct DB mutation as proof of product behavior.
  - No broad redesign, dashboard, trust center, marketplace, or unrelated navigation work in #39.
  - No committed screenshots, live QA data, real Slack IDs/tokens, or session cookies. Evidence should be external/session artifacts with secrets redacted.
  - No special-case secret scanning that ignores admin evidence; scan API/UI/log/evidence outputs for Slack token and Prism developer token shapes.
- Invariants:
  - Global admin, scoped admin, and non-admin outcomes are resolved from current session identity and allowlist only.
  - Scoped admin cannot infer out-of-scope users through list, detail, mutation, audit, counts, or copy.
  - Only global admins edit the Global Token profile policy; scoped admins can inspect read-only.
  - Preset templates are visible and checkbox-backed; manual edits produce Custom.
  - Outside global policy profiles are not silently revoked/rewritten; broadening, rotation, and reissue are blocked until narrowed.
  - Admin destructive actions require exact typed confirmation + reason and create visible metadata-only audit.
  - Admin Remove Slack connection is local Prism deletion with `upstreamCalled: false` audit and no Slack-side revoke/uninstall/admin calls.
  - No Slack credentials, Prism developer token secrets, token hashes, peppers, Slack payloads, raw allowlist contents, or local credential envelopes appear in UI/API/log/evidence.

## Integration plan

- Insert the change at:
  - **Start with QA matrix/evidence:** create a non-committed session artifact/checklist covering personas: global admin, enterprise/team scoped admin, non-admin, in-scope target, out-of-scope target, disconnected retained user, inside-policy profile, outside-policy profile, active profile, revoked/inactive profile.
  - **Environment setup:** run `npm run db:up` if local Postgres is not running, `npm run db:migrate`, prepare a gitignored local admin allowlist (`config/prism-admin-allowlist.local.json`) with safe test Slack IDs, and seed/clean QA data through real app/API/database paths where possible.
  - **Live app proof:** run `npm run dev`, use Playwright/browser to verify admin overview, user directory/detail, global policy page, Token profile create/edit, Outside global policy messaging, and admin destructive dialogs.
  - **API/database proof:** call the real admin/user/token-profile APIs with session cookies for each persona and inspect DB/audit rows for scope, audit metadata, `upstream_called = false`, and cleanup.
  - **Defect fixes:** if QA finds a defect, fix it only in the owning module listed above. Examples: stale admin console copy in `app/admin/admin-shell.tsx`; literal not-found page copy in `app/admin/users/[userId]/page.tsx`; scope leakage in `postgres-user-directory-store.ts`; policy enforcement gaps in `src/server/token-profiles/service.ts`; dialog accessibility/validation in `app/admin/users/*actions.tsx`.
  - **Review and validation:** after any fixes, run focused tests first, then `npm test`, `npm run build`, `npm run db:migrate`, secret-leak scans over captured evidence/logs, architecture review against this brief, and UX/accessibility review of live pages.
- Why this is the correct integration point:
  - #39 validates the composed real system. The correct integration point is the existing product path under test, not a new harness layer that can pass independently of the admin console.
  - Narrow fixes inside current owners preserve PRD semantics and keep future maintenance tied to the module that owns each invariant.
- Alternatives considered and rejected:
  - **New E2E-only mock admin path:** rejected because it would not prove live authorization/scope/audit/Slack-boundary behavior.
  - **Direct DB-only verification:** rejected as insufficient; DB inspection can support proof but browser/API flows must exercise real app behavior.
  - **Central “QA service” abstraction:** rejected unless repeated defect fixes reveal duplicated safety logic that should already be centralized in an existing owner.
  - **Changing Slack credential/OAuth behavior to support admin remove:** rejected; admin remove is explicitly local Prism reset and should not touch Slack APIs.

## Regression checklist

- Behavior: Global admin can access `/admin`, `/admin/users`, `/admin/users/[inScopeUser]`, `/admin/token-profile-policy`, admin APIs, and can update policy.
- Behavior: Scoped admin can access admin shell/directory/detail for in-scope users and inspect policy read-only; PATCH policy is 403.
- Behavior: Non-admin/missing/expired sessions receive generic denial for admin pages/APIs without allowlist internals.
- Behavior: Scoped directory omits out-of-scope users; direct out-of-scope/missing detail/mutation attempts return generic not-found semantics.
- Behavior: Disconnected retained Prism users remain visible when retained metadata proves scope and do not offer current-connection removal.
- Behavior: Policy preset selection fills visible checkboxes in create and edit flows; manual capability edits switch to Custom.
- Behavior: Global policy disabled presets/capabilities stay visible as disabled/explained, not hidden in a way that obscures policy.
- Behavior: Outside global policy messaging appears; rotation, broadening, and reissue/copy-once replacement are blocked until narrowing.
- Behavior: Admin revoke/delete/remove require typed confirmation and reason in UI and APIs before mutation; invalid inputs do not touch mutation stores.
- Behavior: Admin action audit is visible to target users and admins with admin actor, target/object/action/request/reason metadata only.
- Behavior: Admin Remove Slack connection deletes local Prism connection/credentials/dependents as designed, records audit with `upstreamCalled: false`, leaves disconnected user visibility when retained metadata proves scope, and performs no Slack-side revoke/uninstall/admin call.
- Behavior: Local-tool bearer-token flows (`/v1/prism/status`, `/v1/prism/capabilities`, `/v1/slack/api/*`) continue to use Prism developer tokens and are unaffected by admin allowlist.
- Behavior: Slack admin/app/team methods remain unsupported through the Slack-compatible endpoint and do not call upstream.
- Behavior: No secret-shaped values leak through UI, API, logs, audit, or QA evidence.
- Behavior: Full tests, build, migrations, architecture review, UX/accessibility review, secret-leak checks, evidence capture, and QA data cleanup complete.

## Test plan

- Existing tests to keep green:
  - Full suite: `npm test`.
  - Admin authorization/session: `src/server/admin/allowlist.test.ts`, `authorization.test.ts`, `postgres-store.test.ts`, `app/v1/prism/admin/session/route.test.ts`, `app/admin/page.test.tsx`, `app/admin/admin-shell.test.tsx`.
  - Scoped directory/detail: `src/server/admin/user-directory.test.ts`, `postgres-user-directory-store.test.ts`, `app/v1/prism/admin/users/route.test.ts`, `app/v1/prism/admin/users/[userId]/route.test.ts`, `app/admin/users/page.test.tsx`, `app/admin/users/[userId]/page.test.tsx`, `app/admin/users/admin-users.test.tsx`.
  - Global policy: `src/server/token-profiles/global-policy.test.ts`, `global-policy-store.test.ts`, `app/v1/prism/admin/token-profile-policy/route.test.ts`, `app/admin/token-profile-policy/page.test.tsx`.
  - Presets/Outside policy/user profile flows: `src/server/token-profiles/service.test.ts`, `presets.test.ts`, `app/token-profile-policy-options.test.ts`, `app/token-profile-form.test.ts`, `app/token-profiles-panel.test.tsx`, `app/token-profile-detail-panel.test.tsx`, `app/v1/prism/token-profiles/route.test.ts`.
  - Admin actions/audit: `src/server/admin/token-profile-actions.test.ts`, `src/server/admin/slack-connection-actions.test.ts`, admin action route tests, `app/activity-audit-panel.test.tsx`, `src/server/audit/activity.test.ts`, `src/server/audit/postgres-store.test.ts`, `src/server/audit/presentation.test.ts`.
  - Slack boundary: `src/server/slack/connection-management.test.ts`, `src/server/slack/web-api-client.test.ts`, `src/server/slack/method-registry.test.ts`, `app/v1/slack/api/[method]/route.test.ts`, `app/v1/prism/slack-connection/route.test.ts`.
  - Guards: `src/server/dependency-guard.test.ts`, `src/server/docs-guard.test.ts`, secret-focused assertions already present in route/store tests.
- New tests to add before/with implementation:
  - Add or amend tests only for defects discovered during #39 QA. Candidate gaps if live QA exposes them:
    - Server-rendered `/admin/users/[userId]` out-of-scope page copy/status if acceptance demands explicit not-found UX instead of generic admin unavailable.
    - Admin overview stale copy once destructive surfaces are complete.
    - Any uncovered secret-leak path in admin action reason display, admin directory redaction, policy response, or evidence logs.
    - Any missing regression for Slack-side no-call behavior; assert the admin remove store remains SQL/local only and no Slack client module is imported or invoked.
    - Any uncovered keyboard/focus/ARIA defect in admin destructive dialogs or policy preset/template controls.
- Live proof required:
  - Browser evidence for global admin, scoped admin, and non-admin page/API behavior.
  - Browser/API evidence that scoped admin sees only in-scope directory/detail and generic out-of-scope denial.
  - Browser/API evidence that global admin can edit Global Token profile policy and scoped admin sees read-only UI/API 403 on PATCH.
  - Browser evidence for create/edit preset-as-template and Custom transition.
  - Browser/API evidence for Outside global policy message and blocked rotation/broadening/reissue until narrowed.
  - Browser/API/DB evidence that admin revoke/delete/remove require confirmation+reason, fail before mutation when invalid, succeed when valid, and create visible admin audit for target and admin.
  - DB/API/log evidence that admin Remove Slack connection produces local deletion + audit with `upstream_called = false` and no Slack revoke/uninstall/admin request.
  - Command evidence for `npm test`, `npm run build`, `npm run db:migrate` (with local Postgres), architecture review, UX/accessibility review, and secret-leak scans.
  - Cleanup evidence showing temporary QA users/profiles/connections/audit fixtures removed or intentionally retained only as approved non-secret local dev data.

## Risk assessment

- Risk: Scope leakage through direct URLs, mutation responses, audit rows, list counts, or differentiated error copy. Mitigation: route all target checks through `getAdminUserDetail` / directory store scope SQL and keep generic 404/not-found semantics.
- Risk: Secret leakage through admin directory/profile names, admin reasons, audit display, API JSON, console logs, screenshots, or QA evidence. Mitigation: use existing redaction helpers, do not paste secrets into reasons, scan evidence/logs for `prism_dev_`, `xox*`, token/hash/secret/authorization terms, and keep evidence outside the repo.
- Risk: Destructive action semantics regress, allowing mutation without typed confirmation/reason or allowing delete before revoke. Mitigation: preserve admin action service validation and active-delete conflict tests.
- Risk: Admin Remove Slack connection accidentally calls Slack revoke/uninstall/admin APIs or changes user-owned remove semantics. Mitigation: keep admin removal in `src/server/admin/slack-connection-actions.ts`; verify no Slack client imports/calls and `upstreamCalled: false` audit.
- Risk: Global policy UI and service diverge, making disabled controls cosmetic only. Mitigation: validate via service/route tests and live API attempts, not just UI state.
- Risk: Outside global policy behavior silently revokes or rewrites profiles. Mitigation: verify classification + block behavior and that existing profile remains visible until expiry/revocation.
- Risk: QA data contaminates dev environment or screenshots/logs reveal real IDs/secrets. Mitigation: use clearly named QA fixtures, redacted evidence, cleanup SQL/API steps, and avoid committed evidence.
- Risk: Build/migration drift after hardening. Mitigation: run full tests, build, and migrations after any fix; migration must remain idempotent.
- Risk: User-visible regressions/accessibility issues in dialogs/forms. Mitigation: reuse existing UI primitives, verify keyboard/focus/labels/live regions with Playwright/UX review.

## Decision confidence

- Confidence: high
- Reasons:
  - The major #39 behavior already has clear owners and substantial automated coverage across server services, API routes, and UI components.
  - The existing architecture consistently separates admin auth, scoped read models, policy enforcement, admin mutations, audit, and Slack Web API boundaries.
  - Baseline `npm test -- --reporter=dot` passed during scouting (77 files, 243 tests), supporting that the current package is internally coherent before live QA.
- Open questions:
  - Whether #39 requires the server-rendered out-of-scope detail page to present a literal not-found UX rather than the current generic admin access unavailable UI. The API/service already provide generic not-found semantics.
  - Whether stale copy in the admin overview is considered a blocker for final QA; it is user-visible and should be hardened if observed in the live review.
