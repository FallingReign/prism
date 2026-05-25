# Architecture Integration Brief: prism-website-responsive-live-qa-loop

## Existing ownership

- Package/component/module/library:
  - The Prism website App Router surface owns the UX under review: `app/page.tsx` composes the dynamic homepage, `app/slack-status-panel.tsx` owns Slack link status presentation, `app/token-profiles-panel.tsx` owns linked Token profile client interactions, `app/activity-audit-panel.tsx` owns Metadata-only audit presentation, `app/ui.tsx` owns local shadcn-style primitives, and `app/globals.css` owns the OKLCH token/design-system substrate.
  - Slack OAuth/session ownership remains in `app/v1/slack/oauth/**`, `src/server/slack/oauth-flow.ts`, and `src/server/slack/postgres-store.ts#getSlackLinkStatus`.
  - Token profile behavior remains in `app/v1/prism/token-profiles/**`, `src/server/token-profiles/service.ts`, `src/server/token-profiles/store.ts`, and `app/token-profile-form.ts` for browser request-body construction.
  - Activity audit behavior remains in `src/server/audit/**`, `app/v1/prism/activity/route.ts`, and `src/server/audit/presentation.ts`.
  - Validation ownership today is Vitest plus live/manual browser QA. `package.json` has `npm test` and `npm run build`, but no Playwright dependency or config.
- Current owner rationale:
  - Issue #21 is a final QA/UX review loop over the already redesigned website, not a new product subsystem. It should verify and, only if blockers are found, patch the existing website owners above.
  - PRODUCT.md defines the website as the surface for Slack linking, Token profile management, and Metadata-only audit. DESIGN.md defines the responsive light product workspace and local design-system expectations.
  - Recent briefs for #17/#18/#19/#20 already established that the correct integration path is local primitives/CSS tokens inside `app/`, not a parallel Tailwind/shadcn/runtime dashboard path.
- Source evidence:
  - `PRODUCT.md` says success is quickly answering whether Slack is linked/healthy, which Local tools have access, and what Prism forwarded or blocked, while keeping Slack content and credentials out of sight.
  - `DESIGN.md` requires mobile single-column, tablet stacked panels, desktop two-column workspace, visible focus, 44px touch targets, text-plus-color statuses, reduced-motion support, and local reusable components.
  - `app/page.tsx` keeps `export const dynamic = "force-dynamic"`, reads `prism_session`, and only loads Token profiles/activity for linked sessions.
  - `app/token-profiles-panel.tsx` displays copy-once plaintext developer tokens only from immediate create/rotate/policy responses and otherwise renders profile metadata.
  - `app/activity-audit-panel.tsx` explicitly whitelists/redacts visible audit text and states that message text, search queries, file contents, and tokens are not stored.
  - Baseline scout validation: `npm test -- --reporter=dot` passed 45 files / 126 tests. `curl` confirmed the local dev server responds at `http://localhost:3732/` and `/v1/prism/health` with HTTP 200. Playwright MCP could not launch because Chrome was missing at `/opt/google/chrome/chrome`; it reported `npx playwright install chrome` as the remediation.

## Existing interaction model

- User/system behaviors that already exist:
  - Not linked state shows Slack setup copy and `Connect Slack` links to `/v1/slack/oauth/start`; Token profile creation is locked behind Slack linking.
  - Linked healthy state shows Slack identity/workspace or organization, overview metrics, the guided Token profile panel, existing profile list/actions, and recent Metadata-only audit.
  - Reauth-required keeps Token profile management visible while warning that Slack calls need reconnect.
  - Token profile create posts to `/v1/prism/token-profiles`; rotate/revoke/policy update post to the existing profile subroutes; create/rotate/policy broadening can show a plaintext `prism_dev_...` token once in client state.
  - Activity audit renders only safe metadata: method/action, status, token profile/session, UTC time, category, object, identity, request ID, HTTP/upstream/error where present.
  - Dates use `app/date-format.ts` deterministic UTC formatting to avoid hydration drift.
- Behaviors that must remain unchanged:
  - Slack OAuth start/callback/session cookies and server-side encrypted Slack credential custody must not be changed for QA fixes.
  - No browser-visible page, screenshot, test log, issue note, or artifact should include Slack credentials, OAuth client secrets, Authorization headers, token hashes, peppers, Slack message text, search terms, file contents, or plaintext Prism developer tokens except the deliberate copy-once UI state during live Token profile create/rotate verification.
  - Copy-once token behavior must remain copy-once: no token retrieval from profile list, activity, local storage, logs, screenshots intended for sharing, or test fixtures.
  - Activity audit must remain metadata-only; do not render request/response bodies or generic JSON dumps.
  - Responsive layout and accessibility affordances from DESIGN.md must remain: mobile single column, tablet stacked, desktop primary/supporting workspace, visible focus rings, text status labels, 44px primary controls, reduced-motion support, no hover-only controls.
  - `app/page.tsx` must remain dynamic/session-scoped and must not be replaced by a client-only dashboard.
- Runtime or UX evidence:
  - Current CSS has responsive breakpoints at `max-width: 980px` and `max-width: 640px`, 44px button/control sizing, `prefers-reduced-motion`, visible `:focus-visible`, and text-bearing status badges.
  - Current tests protect status copy, deterministic date text, OKLCH/no-inline-style design-system rules, Token profile guide copy, audit no-secret canaries, and backend/API no-secret behavior.
  - Live browser QA is not yet completed in this scout pass because the available Playwright MCP lacks Chrome; the implementation loop must remediate or use an equivalent browser tool before claiming #21 acceptance.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Use the existing local app at `http://localhost:3732` with `npm run dev`, local Postgres via `npm run db:up`/`npm run db:migrate`, and mock OAuth (`PRISM_SLACK_OAUTH_MOCK=1`) where feasible for linked healthy QA without contacting Slack.
  - Use browser automation viewport APIs for desktop/tablet/mobile, console collection, screenshots, navigation, and form exercise. If using Playwright proper, use `page.setViewportSize`, console/pageerror listeners, screenshots, locators, and storage/cookie handling; if using MCP browser tools, use equivalent viewport/screenshot/console facilities.
  - Use existing API routes for state setup: `/v1/slack/oauth/start` then `/v1/slack/oauth/callback?code=...&state=...` for mock-linked sessions; `/v1/prism/token-profiles` to create/list profiles; `/v1/slack/api/{method}` with a copy-once developer token can generate audit rows when `PRISM_SLACK_WEB_API_MOCK=1` is enabled.
  - Use local primitives (`Panel`, `Notice`, `StatusBadge`, `Button`, `LinkButton`, `SummaryMetric`) and `app/globals.css` classes for any UX fixes.
  - Use `app/date-format.ts` for any new date/time text.
  - Use current Vitest style (`renderToStaticMarkup`, helper/unit tests, route tests) for regression tests if fixes change rendered behavior or request-body logic.
- Relevant docs or library capabilities:
  - Next/React hydration requires identical server/client initial markup; console checks should treat React hydration warnings/errors as blockers, not suppress them.
  - Playwright can capture screenshots, accessibility-ish locator/snapshot evidence, console messages, network status, and multi-viewport screenshots. Repository does not currently include Playwright, so do not add a durable Playwright test stack unless the implementer intentionally wants committed QA automation and updates package files accordingly.
  - Chrome/Playwright availability is an environment dependency: current MCP browser launch failed due missing Chrome; remediation should be explicit before live QA.
- Existing examples in this codebase:
  - `README.md` documents local dev on port 3732 and mock OAuth setup flow.
  - `docs/setup.md` documents that developer tokens are copy-once and must not be pasted into logs/docs/screenshots/prompts.
  - `app/design-system.test.ts` is the guard for shared classes, OKLCH tokens, no notice side-stripes, accessible long forms, and non-sticky header behavior.
  - Existing architecture briefs in `docs/implementation-reviews/` define the prior shell, hydration, Token profile, and activity integration constraints that #21 must preserve.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a second frontend app, Pages Router route, client-only status/profile/audit fetch path, global store, auth/session layer, OAuth route, Token profile API, audit API, date formatter, design-system framework, or screenshot-only mock of the UI.
  - Do not install Tailwind/shadcn/Radix/table/form libraries as a quick fix; recent work intentionally uses local shadcn-style primitives and OKLCH CSS tokens to avoid a parallel styling path.
  - Do not bypass Slack OAuth/session flow by manually inserting arbitrary cookies unless a documented test-only setup helper is used and equivalent route-based OAuth proof remains covered.
  - Do not bypass Token profile APIs by seeding UI state in the browser; live QA should exercise real create/list/copy-once paths where feasible.
  - Do not bypass Activity audit by faking rows in the DOM; generate or verify real persisted audit metadata where feasible.
- Shortcuts or parallel paths to avoid:
  - Avoid `suppressHydrationWarning`, client-only rendering, or hiding console errors to pass hydration checks.
  - Avoid screenshots containing visible copy-once developer tokens; if token creation is screenshot-captured, mask/crop after proving the copy-once state or capture immediately before/after token text is visible.
  - Avoid generic `JSON.stringify` rendering, debug panels, hidden hover-only controls, desktop-only metadata, or color-only status indicators.
  - Avoid changing database schema, OAuth semantics, forwarding semantics, token hashing, policy evaluation, rate limits, or audit persistence for UX QA fixes.
  - Avoid committing build-generated drift in `next-env.d.ts`; `npm run build` is known to rewrite a route import and the dev route import should be restored before commit unless intentionally changed.
- Invariants:
  - Slack OAuth/session flow, server-side Slack credential custody, and `prism_session` scoping remain intact.
  - Token profile copy-once/no-secret behavior remains intact.
  - Activity audit renders metadata only and redacts credential-shaped canaries.
  - Responsive layout remains usable at mobile, tablet, and desktop viewports.
  - Hydration stability and console cleanliness are blockers.
  - The local design-system substrate (`app/ui.tsx`, `app/globals.css`, OKLCH tokens) remains the styling path.

## Integration plan

- Insert the change at:
  - Primary QA execution outside product code: run the live local app, open the real homepage in browser automation, exercise not-linked (if feasible), linked healthy, Token profile create/list/copy-once, and Activity audit states across mobile/tablet/desktop, capture screenshots/evidence, collect console/page errors, and run UX subagent critique against PRODUCT.md, DESIGN.md, and PRD #16.
  - If fixes are required, insert them only into the existing owners: `app/page.tsx`, `app/slack-status-panel.tsx`, `app/token-profiles-panel.tsx`, `app/activity-audit-panel.tsx`, `app/ui.tsx`, and/or `app/globals.css`; add/update tests beside the affected owner.
  - If browser tooling must be made durable, add the smallest explicit QA tooling path (for example Playwright dev dependency/config/script) only after deciding that MCP/equivalent ad hoc browser QA is insufficient; otherwise keep QA evidence as artifacts/issue notes rather than a new committed test stack.
  - Capture evidence in a non-secret location associated with the implementation review/issue (for example issue comment and/or a clearly named local evidence folder under `docs/implementation-reviews/` if the team wants committed artifacts). Do not store secret-bearing screenshots.
- Why this is the correct integration point:
  - The slice is a validation/iteration loop over the existing website, so the first integration point is the real runtime/browser path. Product fixes should be applied where the verified UX is owned, not in data/service layers.
  - Existing components already have clear ownership and tests; patching them preserves established boundaries and avoids parallel UI/data paths.
  - Live route-based setup best protects the actual Slack OAuth/session, Token profile, copy-once, and audit flows that screenshots and UX review need to prove.
- Alternatives considered and rejected:
  - Adding a parallel mock QA page or Storybook-like fixture route: rejected because acceptance requires the real local app and core states.
  - Replacing live browser QA with static markup tests only: rejected because #21 explicitly requires browser viewport/hydration/console/screenshot evidence.
  - Seeding database/UI in undocumented ways as the primary proof: rejected because it bypasses OAuth/session/API behavior; may be used only as a secondary fallback with the limitation documented.
  - Installing a full UI framework to address critique findings: rejected as a parallel styling path around the existing local design system.

## Regression checklist

- Behavior: Not-linked homepage still shows Slack status/setup copy and `Connect Slack` hrefs to `/v1/slack/oauth/start` without secret material.
- Behavior: Linked healthy homepage still shows Slack identity/scope, overview metrics, Token profiles, and Activity audit for the session only.
- Behavior: Reauth-required still preserves Token profile management and shows reconnect guidance.
- Behavior: Token profile create/list/rotate/revoke/policy endpoints, payload fields, disabled/loading/error labels, status labels, expiry/last-used/overlap/revoked metadata, and copy-once plaintext token semantics still work.
- Behavior: Plaintext Prism developer tokens are not visible after the copy-once state is cleared and are not present in screenshots/logs/fixtures intended for sharing.
- Behavior: Activity audit remains metadata-only, whitelisted, redacted, and scannable with method/action, status, profile/session, timestamp, category, object, identity, request ID, HTTP/upstream/error where present.
- Behavior: Date/time output remains deterministic UTC; no default-locale date formatting or hydration mismatches return.
- Behavior: Responsive layout remains mobile single-column, tablet stacked, desktop primary/supporting workspace; focus rings, touch targets, reduced motion, keyboard paths, and no hover-only controls remain intact.
- Behavior: Browser console has no React hydration, runtime, route, resource, or accessibility-obvious errors after final fixes.
- Behavior: `npm test` and `npm run build` pass; restore unintended `next-env.d.ts` route-import drift after build.

## Test plan

- Existing tests to keep green:
  - Full `npm test` suite (baseline scout run: 45 files / 126 tests passed).
  - `npm run build` after implementation/fixes, with a post-build check of `git status` for the known `next-env.d.ts` rewrite quirk.
  - Component/design tests: `app/slack-status-panel.test.tsx`, `app/token-profiles-panel.test.tsx`, `app/activity-audit-panel.test.tsx`, `app/ui.test.tsx`, `app/design-system.test.ts`, `app/date-format.test.ts`, `app/website-overview.test.ts`, `app/token-profile-form.test.ts`.
  - Route/service tests for OAuth, token profiles, activity, Slack forwarding, token policy, audit, health/status/capabilities, dependency/docs guards.
- New tests to add before/with implementation:
  - If a UX fix changes rendered copy/layout semantics, add static render tests asserting the user-visible behavior and no-secret canaries.
  - If a fix changes Token profile form/request-body logic, add/update `app/token-profile-form.test.ts` and route/service tests as appropriate.
  - If a fix touches dates/hydration-sensitive rendering, add/extend guards against default `toLocaleString()`/`toLocaleDateString()` in website components.
  - If committed browser automation is introduced, add a minimal Playwright smoke covering desktop/tablet/mobile, console/pageerror collection, screenshots, and linked mock setup; otherwise document manual/MCP QA evidence rather than committing half-maintained automation.
- Live proof required:
  - Browser QA at desktop (for example 1440x900), tablet (for example 768x1024), and mobile (for example 390x844 or 375x812).
  - Screenshots or equivalent visual evidence for linked healthy state at all required viewports, with no visible secrets.
  - Console/pageerror capture showing no hydration/runtime errors.
  - Exercise not linked if feasible; linked healthy via real/mock OAuth; Token profile list/create/copy-once; Activity audit after listing/creating profiles or making a mock Slack-compatible call.
  - UX subagent critique against PRODUCT.md, DESIGN.md, and PRD #16; blocking findings fixed or explicitly accepted by the user.
  - User-facing verification instructions and final user approval before closing the slice.

## Risk assessment

- Risk: Browser QA may falsely pass if it uses a fixture/mock route rather than the real session-scoped app.
- Risk: Screenshots or logs may leak copy-once Prism developer tokens, OAuth state, Authorization headers, Slack credential canaries, or local secrets.
- Risk: Quick UX fixes could break OAuth/session scoping, Token profile API payloads, copy-once semantics, activity metadata-only guarantees, or deterministic date formatting.
- Risk: Responsive CSS changes could regress desktop hierarchy, mobile single-column usability, keyboard/focus behavior, touch target size, or reduced-motion handling.
- Risk: Adding Playwright or UI libraries could introduce unnecessary package/config churn and a parallel QA/styling path.
- Risk: `npm run build` may rewrite `next-env.d.ts`, creating unrelated diff noise.
- Mitigation:
  - Drive QA through the real local app and existing routes; document any fallback/seeding limitations.
  - Redact/crop/avoid screenshots containing token text; never paste bearer tokens or secrets into issue notes.
  - Make fixes only in established website owners and add focused tests for changed behavior.
  - Re-run full tests, production build, browser console checks, and multi-viewport screenshots after every blocking-fix pass.
  - Keep browser tooling additions intentional and minimal; prefer existing MCP/equivalent if it can satisfy evidence.
  - Check `git status` after build and restore unintentional generated file drift.

## Decision confidence

- Confidence: high
- Reasons:
  - Existing ownership is clear from current code and prior briefs: #21 validates and iterates the existing App Router website, local primitives, Token profile panel, Activity audit panel, and OAuth/session/API routes.
  - The current code and docs are mostly aligned after #17-#20: local OKLCH design-system substrate exists, responsive breakpoints exist, copy-once/no-secret behavior is tested, and activity is metadata-only.
  - Baseline tests pass, local server is reachable, and the remaining uncertainty is browser-tool availability plus user/UX reviewer approval, not architecture placement.
  - The brief identifies concrete no-bypass rules that protect Slack OAuth/session flow, token profile copy-once/no-secret behavior, activity audit metadata-only rendering, responsive layout, hydration stability, and the local design-system substrate.
- Open questions:
  - Browser tooling: should the implementer use the external/MCP Playwright environment after installing Chrome, or commit a minimal Playwright dev dependency/config/script for repeatable QA? Recommendation: use existing browser tooling if it can be remediated quickly; only commit Playwright if durable automation is explicitly desired.
  - Evidence persistence: should screenshots live in a committed docs evidence folder or only in issue comments/session artifacts? Recommendation: avoid committing secret-prone screenshots unless they are clearly redacted and useful long-term.
  - Human approval: #21 requires user approval of final website direction; no implementation should close the issue without a documented approval or explicit acceptance of remaining non-blocking UX findings.
