# Architecture Integration Brief: prism-website-tailwind-shadcn-reset

## Existing ownership

- Package/component/module/library:
  - The Prism website is a Next.js App Router surface under `app/`. `app/page.tsx` composes the dynamic homepage, reads the `prism_session` cookie, and conditionally loads Slack status, Token profiles, and Activity audit data.
  - Current visual primitives live in `app/ui.tsx` (`Button`, `LinkButton`, `Panel`, `StatusBadge`, `Notice`, `SummaryMetric`, `cx`) and their hand-rolled class substrate lives in `app/globals.css`.
  - Product panels own behavior and copy: `app/slack-status-panel.tsx`, `app/token-profiles-panel.tsx`, `app/activity-audit-panel.tsx`, plus `app/token-profile-form.ts`, `app/website-overview.ts`, and `app/date-format.ts`.
  - Backend/session/API ownership remains outside the styling slice: Slack OAuth/session in `app/v1/slack/oauth/**` and `src/server/slack/**`; Token profile routes/service/store in `app/v1/prism/token-profiles/**` and `src/server/token-profiles/**`; audit in `app/v1/prism/activity/route.ts` and `src/server/audit/**`.
  - Tailwind/shadcn ownership does not exist yet. `package.json` has Next 16, React 19, React DOM 19, pg, server-only, TypeScript, and Vitest only; no `tailwindcss`, `@tailwindcss/postcss`, `postcss.config.mjs`, `components.json`, `components/ui`, `lib/utils`, Radix, CVA, clsx, tailwind-merge, lucide, or shadcn-generated components.
- Current owner rationale:
  - The current UI was intentionally centralized in local primitives, but the user rejected the hand-rolled visual result. The new owner for reusable visual controls should become real shadcn/ui source components in `components/ui/*` styled by Tailwind v4 tokens in `app/globals.css`.
  - Product behavior should stay with the existing App Router pages/panels. The reset is a visual substrate replacement, not a data model, auth, API, or product-flow rewrite.
  - `PRODUCT.md` and `DESIGN.md` require proven product UI patterns, consistent controls, visible trust boundaries, metadata-only audit, copy-once Token profile handling, OKLCH tokens, WCAG AA, responsive layouts, and no generic flashy dashboard. Those requirements are compatible with Tailwind + shadcn if Prism tokens drive shadcn variables instead of accepting generic defaults.
- Source evidence:
  - `app/ui.tsx` exports local shadcn-style primitives backed by class names such as `button`, `panel`, `status-badge`, `notice`, and `summary-metric`.
  - `app/globals.css` contains ~1000 lines of custom class selectors for layout, forms, buttons, badges, notices, profile cards, audit cards, responsive breakpoints, focus rings, and reduced motion.
  - `app/page.tsx` imports local primitives from `./ui`, sets `export const dynamic = "force-dynamic"`, reads `prism_session`, and only loads Token profiles/activity when Slack is linked.
  - `app/token-profiles-panel.tsx` is a client component that posts to existing Token profile endpoints and stores plaintext developer tokens only in immediate React state.
  - `app/activity-audit-panel.tsx` renders metadata rows and redacts credential-shaped values with `safeAuditText`.
  - `app/design-system.test.ts` currently guards the old custom substrate directly by reading `app/globals.css` and asserting specific custom selectors, OKLCH tokens, no notice side stripe, long-form accessibility classes, and local primitive source files.
  - Baseline validation during scout: `npm test -- --reporter=dot` passed 45 files / 126 tests. `npm run build` was not run by the scout to avoid the known `next-env.d.ts` rewrite while this brief-only task is the only allowed file edit.

## Existing interaction model

- User/system behaviors that already exist:
  - Not-linked state shows Slack setup copy and `Connect Slack` links to `/v1/slack/oauth/start`; Token profile creation is unavailable until Slack is linked.
  - Setup-required state explains missing Slack OAuth/encryption configuration.
  - Linked healthy state shows identity and workspace/organization, overview metrics, guided Token profile creation, existing profile management actions, and recent Activity audit.
  - Reauth-required state keeps profile management visible while showing reconnect guidance.
  - Token profile create posts JSON to `/v1/prism/token-profiles`; rotate, revoke, and policy update post to existing profile subroutes. Create/rotate/policy broadening can show a plaintext `developerToken` once in client state.
  - Token profile forms include purpose, access preset/custom capabilities, destructive opt-in, execution identity, experiment expiry, broadening confirmation, loading labels, disabled busy buttons, `role="alert"`, and `aria-live="polite"` status text.
  - Activity audit shows safe metadata only: Slack method/lifecycle label, policy category, status, profile/session, UTC timestamp, object, identity, request ID, HTTP status, upstream handling, and error class.
  - Dates are rendered by `app/date-format.ts` as deterministic UTC strings to avoid hydration drift.
- Behaviors that must remain unchanged:
  - Slack OAuth/session flow, routes, cookie scoping, encrypted server custody, and linked/not-linked/reauth semantics.
  - Token profile request payload shape and endpoint usage; profile create/list/rotate/revoke/policy update behavior; copy-once plaintext developer token behavior; no token retrieval from profile lists, audit, storage, logs, or screenshots intended for sharing.
  - Activity audit metadata-only/no-secret behavior, including redaction of credential-shaped canaries and no rendering of request bodies, Slack message text, search queries, file contents, token hashes, peppers, refresh secrets, Authorization values, or Slack credentials.
  - Deterministic UTC date formatting and no environment-dependent `toLocaleString()` rendering.
  - Responsive product shape from `DESIGN.md`: mobile single-column setup flow, tablet stacked panels, desktop primary Token profile workspace with supporting status/audit context.
  - Accessibility affordances: semantic headings/regions/lists/forms, visible focus, text-plus-color statuses, 44px-ish touch targets for primary controls, no hover-only controls, reduced-motion support, and form errors that explain recovery.
  - `app/page.tsx` must remain a server-rendered dynamic session-scoped App Router page, not a client-only dashboard.
- Runtime or UX evidence:
  - Current tests assert Slack status no-secret copy, organization fallback, reauth guidance, Token profile guided steps/actions/copy-once placeholder/no-secret canaries, audit metadata/no-secret canaries, deterministic UTC formatting, and overview counts.
  - Current CSS has responsive breakpoints at `max-width: 980px` and `max-width: 640px`, `:focus-visible`, `prefers-reduced-motion`, 44px controls, and text-bearing status badges, but these are part of the rejected visual substrate and should be reimplemented through Tailwind/shadcn rather than preserved selector-for-selector.
  - Issue #21 requires final browser QA at mobile/tablet/desktop, linked healthy screenshots, console/hydration checks, not-linked/linked/profile/audit state exercise, UX review, full tests, production build, and user approval.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add Tailwind v4 as the single styling compiler for the website: `tailwindcss`, `@tailwindcss/postcss`, `postcss`, and `postcss.config.mjs`; import Tailwind from `app/globals.css` with `@import "tailwindcss"`.
  - Add shadcn/ui for real component source, not a runtime component dependency. Create `components.json`, `components/ui/*`, and `lib/utils.ts` (`cn` using `clsx` + `tailwind-merge`). Add the `@/*` path alias in `tsconfig.json` because the app currently has no alias.
  - Map Prism OKLCH tokens into shadcn/Tailwind CSS variables in `app/globals.css`: `--background`, `--foreground`, `--card`, `--primary`, `--muted`, `--border`, `--ring`, `--destructive`, radius variables, and optional Prism-specific semantic aliases. Keep Prism's light-first identity; do not make dark mode the default aesthetic shortcut.
  - Use shadcn-generated components as primitives and compose Prism wrappers only where product semantics require it. Recommended minimal set: `button`, `card`, `badge`, `alert`, `input`, `label`, `select`, `checkbox`, `radio-group`, `separator`, and optionally `textarea` if multi-line intended-use copy is desired. Consider `table` only if the audit/profile metadata is redesigned as a true table; current definition lists are semantically acceptable.
  - Use existing React state and fetch handlers in `TokenProfilesPanel`; use Tailwind class names for layout and shadcn components for controls. Do not add a form library solely for this slice.
  - Use existing `formatUtcDate`/`formatUtcDateTime`, `buildWebsiteOverview`, `buildCreateTokenProfileRequestBody`, and `buildPolicyUpdateRequestBody` rather than duplicating formatting or payload logic.
- Relevant docs or library capabilities:
  - Tailwind's Next.js guide for v4 installs `tailwindcss`, `@tailwindcss/postcss`, and `postcss`, configures `postcss.config.mjs` with the `@tailwindcss/postcss` plugin, imports `@import "tailwindcss"` in `app/globals.css`, then uses utility classes in App Router files.
  - shadcn's Next/existing-project docs require Tailwind first, a `@/*` import alias when using default imports, `components.json`, and generated component source imported from `@/components/ui/...`.
  - shadcn manual installation for Tailwind v4 uses CSS-variable theming in global CSS, `@theme inline`, `cn` from `clsx` + `tailwind-merge`, and aliases for `components`, `ui`, `lib`, `utils`, and `hooks`.
  - shadcn React 19 docs say latest shadcn has full React 19 and Tailwind v4 support, but npm peer dependency resolution can still require `--legacy-peer-deps` or `--force` for packages whose peer ranges lag; test thoroughly after installing.
  - shadcn Button docs note Tailwind v4 uses default cursor for buttons; if Prism wants pointer affordance, add the documented base rule for `button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer; }` or initialize with the shadcn pointer option.
  - For link-styled buttons, use shadcn `Button` with `asChild` and Next/anchor elements rather than maintaining a parallel `LinkButton` styling implementation.
- Existing examples in this codebase:
  - Current `Panel` maps naturally to shadcn `Card` composition (`Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`/`CardAction`) plus Prism-specific section semantics via wrappers or `asChild` if available.
  - Current `StatusBadge` maps to shadcn `Badge` plus Prism tone variants/classes.
  - Current `Notice` maps to shadcn `Alert`, `AlertTitle`, and `AlertDescription`.
  - Current `Button`/`LinkButton` map to shadcn `Button` variants (`default`, `secondary`, `outline`, `ghost`, `destructive`) with Prism tokens.
  - Current form controls map to shadcn `Input`, `Label`, `Select`, `Checkbox`, and `RadioGroup`, while keeping existing `name` values for `FormData`.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not replace Slack OAuth/session routes, database stores, token hashing, policy evaluation, rate limits, forwarding, audit persistence, or service-layer APIs for styling.
  - Do not create a second frontend app, Pages Router route, static mock dashboard, Storybook-only surface, client-only data fetching path, global client store, or fixture route as the real website.
  - Do not keep `app/ui.tsx` as a second competing design system after adopting shadcn. Either remove it or reduce it to thin Prism semantic wrappers that import `components/ui/*` and contain no hand-rolled visual substrate.
  - Do not keep the current large custom class vocabulary in `app/globals.css` while adding Tailwind/shadcn. Global CSS should hold Tailwind imports, shadcn theme variables/base rules, and small global/body effects only; component layout should move to Tailwind utilities and shadcn variants.
  - Do not introduce a broad Radix/form/table/dialog dependency set beyond components actually needed by current Prism surfaces.
- Shortcuts or parallel paths to avoid:
  - Avoid a bad hybrid where old classes (`button--primary`, `panel--success`, `choice-card`, `profile-card`, etc.) continue to drive the UI while shadcn components are sprinkled in. That would preserve the rejected substrate and create two styling systems.
  - Avoid copying shadcn-looking snippets manually instead of using/generated real shadcn source and dependencies.
  - Avoid accepting generic shadcn defaults without mapping Prism OKLCH tokens and DESIGN.md requirements; this would satisfy dependency checklists but fail brand/product quality.
  - Avoid changing form `name` attributes, endpoint URLs, request body builders, status labels, or copy-once state while replacing visual components.
  - Avoid `suppressHydrationWarning`, default-locale date formatting, browser-only rendering for server data, or console-error suppression.
  - Avoid screenshots, logs, fixture data, test output, or issue notes that expose `prism_dev_...`, Slack `xox*` tokens, `client_secret`, `access_token`, token hashes, peppers, refresh secrets, Authorization headers, Slack message content, search queries, or file contents.
- Invariants:
  - Tailwind/shadcn becomes the single visual substrate for current website components.
  - Product behavior remains owned by existing App Router panels and server/API modules.
  - Slack credentials remain server-held; local tools receive opaque Prism developer tokens only.
  - Developer tokens remain copy-once and are never retrievable from profile list/audit/storage.
  - Activity audit remains metadata-only and redacted.
  - Deterministic UTC dates remain.
  - Responsive, accessible, light-first Prism product UI remains.

## Integration plan

- Insert the change at:
  - Package/config layer: add Tailwind v4 and shadcn dependencies/config (`package.json`, `package-lock.json`, `postcss.config.mjs`, `components.json`, `tsconfig.json` alias, `lib/utils.ts`, `components/ui/*`). Use npm consistently because the repository uses `package-lock.json`.
  - Global styling layer: replace `app/globals.css` with Tailwind v4 imports, shadcn CSS variable/theme setup, Prism OKLCH token mapping, base typography/body/focus/reduced-motion rules, and only minimal global background/selection/screen-reader utilities if needed.
  - Component layer: replace or adapt `app/ui.tsx` so product code imports real shadcn components or thin Prism wrappers built on shadcn components. Prefer deleting `app/ui.tsx` if imports can move cleanly to `@/components/ui/*` and local semantic wrappers are unnecessary; otherwise keep it as a compatibility wrapper during the slice only if it does not own visual styles.
  - Product surfaces: adapt `app/page.tsx`, `app/slack-status-panel.tsx`, `app/token-profiles-panel.tsx`, and `app/activity-audit-panel.tsx` to use Tailwind utilities and shadcn components while preserving existing copy, ARIA, form names, fetch handlers, IDs, and conditional states.
  - Tests: update tests that assert old classes/substrate, keep behavior/security tests green, and add tests that verify real Tailwind/shadcn integration and no fallback to old custom classes.
- Why this is the correct integration point:
  - The rejected part is the visual substrate, not the product flow. Replacing the primitive/component/style ownership keeps high-risk auth/token/audit behavior stable.
  - shadcn is designed as owned source components in `components/ui`, so it should become the local primitive library rather than a dependency hidden behind old `app/ui.tsx` classes.
  - Tailwind v4 belongs at the global PostCSS/CSS entrypoint and utility-class usage sites. Keeping old CSS selectors alongside Tailwind would create exactly the parallel styling path the reset is meant to eliminate.
  - Product surfaces are small enough that a real vertical replacement is feasible without introducing Storybook, a new route, or backend churn.
- Alternatives considered and rejected:
  - Keep old `app/ui.tsx` and merely restyle CSS to look more like shadcn: rejected because the user approved a real Tailwind/shadcn rebuild and rejected the hand-rolled result.
  - Add Tailwind only but no shadcn components: rejected because due diligence specifically approved shadcn/ui as the quality component baseline.
  - Add shadcn components while leaving most `app/globals.css` custom classes intact: rejected as a likely bad hybrid and parallel styling path.
  - Rewrite website as a fully client-side dashboard: rejected because it would bypass the dynamic App Router/session data model and increase hydration/security risk.
  - Add a comprehensive form/table/dialog framework now: rejected as overkill; current form state and simple controls are sufficient.

## Regression checklist

- Behavior: Not-linked, setup-required, linked healthy, and reauth-required Slack status states still render correct copy, identity/scope, and `/v1/slack/oauth/start` actions without secrets.
- Behavior: `app/page.tsx` remains `force-dynamic`, reads `prism_session`, and only reads Token profiles/activity for linked sessions.
- Behavior: Token profile create/list/rotate/revoke/policy update use the same endpoints, HTTP methods, JSON payload fields, form names, busy states, error states, and copy-once developer-token semantics.
- Behavior: Plaintext `developerToken` appears only in the deliberate copy-once create/rotate/policy-broadening UI state and never in existing profile metadata, audit, local storage, logs, fixtures, or screenshots intended for sharing.
- Behavior: Activity audit remains metadata-only, redacts credential-shaped canaries, and does not expose Slack message text, search queries, file contents, request/response bodies, token hashes, peppers, refresh secrets, Authorization values, or credentials.
- Behavior: Dates and audit/profile timestamps remain deterministic UTC via `app/date-format.ts`; no hydration drift from locale formatting.
- Behavior: Responsive layouts satisfy issue #21: mobile single-column, tablet stacked/usable, desktop two-column product workspace with Token profiles as primary area.
- Behavior: Accessibility remains at least as strong: semantic headings/labels/fieldset or equivalent radio/checkbox labeling, visible focus rings, keyboard paths, status text beyond color, 44px-ish touch targets for important actions, `role="alert"`/`aria-live` where currently used, no hover-only controls, reduced motion respected.
- Behavior: Browser console has no hydration/runtime errors after the rebuild.
- Behavior: Full `npm test` and `npm run build` pass; after build, restore unintended `next-env.d.ts` route-import drift before commit.

## Test plan

- Existing tests to keep green:
  - Full `npm test` suite (scout baseline: 45 files / 126 tests passed).
  - Website component tests: `app/slack-status-panel.test.tsx`, `app/token-profiles-panel.test.tsx`, `app/activity-audit-panel.test.tsx`, `app/website-overview.test.ts`, `app/date-format.test.ts`, `app/token-profile-form.test.ts`.
  - Route/service/security tests for OAuth/session, token profiles, forwarding, audit, health/status/capabilities, config, dependency guard, and docs guard.
  - Production build after implementation; check `git status` and restore known generated `next-env.d.ts` drift if it appears.
- New tests to add before/with implementation:
  - Replace `app/design-system.test.ts` assertions that enforce old custom CSS selectors with guards for the new substrate: Tailwind import/PostCSS config exists, `components.json` exists, `components/ui` shadcn components are used, Prism OKLCH tokens map to shadcn CSS variables, no inline styles, no banned notice side stripe/background-clip text, and no old class selectors such as `.button--`, `.panel--`, `.status-badge--`, `.choice-card`, `.profile-card`, or `.activity-card` remain as the visual substrate.
  - Replace or remove `app/ui.test.tsx` depending on the chosen migration. If `app/ui.tsx` is removed, add render tests around shadcn-backed panels/surfaces instead. If kept as wrappers, update it to prove wrappers render shadcn/Tailwind classes and no secrets, not old class names.
  - Update component render tests that currently assert old class strings, e.g. `status-badge status-badge--success`, to assert semantic text/roles/no-secret behavior or new shadcn/Tailwind markers that are not brittle implementation details.
  - Add a targeted guard that product files import from `@/components/ui/*` or approved shadcn-backed wrappers, not raw old visual classes from `app/ui.tsx`.
  - If controls are changed to Radix-backed `Select`, `RadioGroup`, or `Checkbox`, add/update form request-body tests to ensure `FormData` names and default values still produce the same payloads.
  - If any date or client/server rendering changes, extend `app/date-format.test.ts` guards against default locale formatting and hydration-sensitive constructs.
- Live proof required:
  - Run the real local app, preferably with mock OAuth/Web API where feasible, and QA desktop (e.g. 1440x900), tablet (768x1024), and mobile (390x844/375x812) viewports.
  - Capture screenshots or equivalent visual evidence for linked healthy state at all required viewports; avoid or redact copy-once token text.
  - Collect browser console/page errors and verify no hydration/runtime errors.
  - Exercise not-linked if feasible, linked healthy via real/mock OAuth, Token profile list/create/copy-once, profile rotate/revoke/policy controls, and Activity audit after profile activity or a mock Slack-compatible call.
  - Run UX review against `PRODUCT.md`, `DESIGN.md`, and issue #21 acceptance criteria; fix blocking findings or get explicit user acceptance.
  - Provide user-facing verification instructions before final approval.

## Risk assessment

- Risk: A hybrid implementation keeps the rejected `app/globals.css` class system while adding Tailwind/shadcn, producing another inconsistent UI and two styling paths.
- Risk: shadcn/Tailwind defaults could erase Prism's product identity, light-first OKLCH palette, status semantics, focus/touch/reduced-motion requirements, or security/trust-boundary copy.
- Risk: Replacing form controls with Radix/shadcn controls could accidentally change submitted `FormData`, default checked/selected values, disabled/loading states, or keyboard behavior.
- Risk: Visual refactor could accidentally expose developer tokens/secrets, remove audit redaction, render generic JSON/debug data, or include secret-bearing screenshots.
- Risk: Moving layout/component ownership could break dynamic server rendering, linked-session scoping, or deterministic UTC rendering and introduce hydration warnings.
- Risk: npm + React 19 peer dependencies may require `--legacy-peer-deps`/`--force`; Next 16 + Tailwind v4/shadcn latest should work, but only if current CLI/components are used and the app is tested.
- Risk: Tailwind v4 button cursor behavior defaults to `cursor: default`, which may feel broken compared with Prism's current pointer buttons unless intentionally addressed.
- Risk: `npm run build` may rewrite `next-env.d.ts`, creating unrelated generated diff noise.
- Mitigation:
  - Treat Tailwind/shadcn as a replacement substrate: remove old visual class dependencies and add tests that prevent regression to old selectors.
  - Map Prism OKLCH tokens into shadcn CSS variables before rebuilding surfaces; review against PRODUCT/DESIGN rather than generic demos.
  - Keep existing handlers/request builders/date formatters/redaction functions; test form payloads and render output after every component swap.
  - Use real browser QA and console checks across viewports; never store/share copy-once token text.
  - Use npm consistently; if peer resolution requires a flag, document it and run full tests/build/live QA.
  - Add the documented Tailwind v4/shadcn cursor base rule if pointer affordance is desired.
  - Check and clean `git status` after build.

## Decision confidence

- Confidence: high
- Reasons:
  - Current ownership is clear and confined: the rejected layer is `app/ui.tsx` + `app/globals.css` and product component styling, while product behavior remains in existing panels/routes/services.
  - Tailwind v4 and current shadcn docs explicitly support Next/App Router, React 19, Tailwind v4, CSS-variable theming, and source-owned components, matching the approved direction.
  - Baseline tests pass, and the risky invariants are already well covered by existing render/service tests; only the old design-substrate tests need intentional replacement.
  - A minimal shadcn component set is enough for Prism's current surfaces, avoiding overbuilt dialogs/tables/forms while still replacing the hand-rolled baseline.
- Open questions:
  - Exact shadcn style/base color should be selected during implementation. Recommendation: use the current shadcn default/latest style with CSS variables, then override tokens to Prism OKLCH rather than relying on generic neutral defaults.
  - Whether to delete `app/ui.tsx` immediately or keep thin shadcn-backed wrappers for semantic migration. Recommendation: delete if imports remain clean; otherwise keep only wrapper semantics and no custom visual substrate.
  - Whether to commit durable Playwright tests for issue #21 or keep live QA as session/issue evidence. Recommendation: only add committed Playwright if the user wants repeatable browser automation; otherwise use existing browser tooling for evidence.
