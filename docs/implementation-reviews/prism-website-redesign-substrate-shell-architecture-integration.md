# Architecture Integration Brief: prism-website-redesign-substrate-shell

## Existing ownership

- Package/component/module/library:
  - **Website structure:** `app/layout.tsx` imports `app/globals.css` and wraps App Router children; `app/page.tsx` owns the dynamic homepage structure and server-side composition (`dynamic = "force-dynamic"`, cookie lookup, Slack status, Token profile summaries, activity summaries).
  - **Styling:** `app/globals.css` owns all current visual language through global class names such as `.shell`, `.hero`, `.cards`, `.status-card`, `.button`, `.notice`, `.token-form`, `.profile-list`, and `.activity-status`. There is no Tailwind config, PostCSS config, shadcn registry, component library, or CSS module owner today.
  - **Status display:** `app/slack-status-panel.tsx` owns Slack status rendering for `not_linked`, `setup_required`, `linked/healthy`, and `linked/reauth_required`, including OAuth start/reconnect links to `/v1/slack/oauth/start`.
  - **Token profile and audit surfaces:** `app/token-profiles-panel.tsx` owns client-side create/rotate/revoke/policy UI state and copy-once developer-token display. `app/activity-audit-panel.tsx` owns metadata-only recent activity rendering. These are integration surfaces only for #17/#18; do not redesign their workflows in this tranche.
  - **Data owners:** `src/server/slack/postgres-store.ts#getSlackLinkStatus`, `src/server/token-profiles/service.ts#listTokenProfiles`, `src/server/token-profiles/store.ts`, `src/server/audit/postgres-store.ts`, and `src/server/audit/presentation.ts#toActivityAuditSummary` own session-scoped status/profile/activity data.
  - **Tests:** Vitest owns protection. Website render tests are in `app/slack-status-panel.test.tsx`, `app/token-profiles-panel.test.tsx`, `app/activity-audit-panel.test.tsx`, and `app/date-format.test.ts`; route/service/security coverage is under `app/v1/**` and `src/server/**`.
- Current owner rationale:
  - PRODUCT.md defines the website as the product surface for Slack linking, Token profile management, and Metadata-only audit review; DESIGN.md defines a light product workspace with OKLCH Prism tokens and local reusable components.
  - Existing architecture briefs identify the Prism website App Router surface as the correct owner for setup/status/profile/audit presentation and warn against duplicating session, token, audit, or date-formatting paths.
- Source evidence:
  - `package.json` has `next`, `react`, `react-dom`, `pg`, and `server-only`; no Tailwind, shadcn, Radix, class-variance-authority, tailwind-merge, or UI dependency is installed.
  - `next.config.ts` only configures Turbopack root; no Tailwind/PostCSS pipeline exists.
  - Baseline checks: `npm test` passes 41 files / 112 tests. `npm run build` passes and lists dynamic App Router routes for `/`, `/v1/prism/*`, and `/v1/slack/*`.
  - `npm test -- --runInBand` fails because Vitest does not support Jest's `--runInBand`; use `npm test` for validation.

## Existing interaction model

- User/system behaviors that already exist:
  - Homepage is dynamic and session-scoped. It reads the `prism_session` cookie, resolves Slack link status, and only loads Token profiles/activity when Slack is linked.
  - Not linked users see a Slack link card and a `Connect Slack` link to `/v1/slack/oauth/start`.
  - Setup-required users see missing OAuth/encryption configuration guidance.
  - Linked healthy users see Slack identity and workspace/organization scope without credential material.
  - Reauth-required users see the same identity context, a warning, and `Reconnect Slack` to the same OAuth start route.
  - Linked users can manage Token profiles through existing client-side forms: create/copy once, rotate, revoke, update policy; reauth-required state preserves profile management with a warning.
  - Activity audit shows safe metadata only and currently renders method/lifecycle label, status, profile/session, time, category, object, identity, and error class.
  - Date display uses `app/date-format.ts` deterministic UTC formatting to avoid hydration mismatch.
- Behaviors that must remain unchanged:
  - Slack OAuth start/callback routes and the `/v1/slack/oauth/start` href must keep working.
  - Browser-visible UI must not expose Slack tokens, refresh tokens, client secrets, developer-token hashes, Slack message text, search queries, file contents, or credential material.
  - Token profile API behavior, copy-once plaintext token semantics, rotate/revoke/policy actions, profile list metadata, and reauth preservation must not change in #17/#18.
  - Activity audit remains metadata-only; no payload/body expansion.
  - Server/client boundaries stay intact: App Router server page fetches data; `TokenProfilesPanel` remains the small client component that owns interactive profile actions.
  - Hydration-safe date formatting must remain centralized through `app/date-format.ts`.
- Runtime or UX evidence:
  - Existing render tests assert OAuth links, visible status copy, deterministic date text, and no secret-like strings.
  - PRODUCT.md/DESIGN.md conflict with current runtime aesthetics: current CSS is dark/cyberpunk-like, uses hardcoded hex colors, Arial/Helvetica, ad hoc global class vocabulary, pill buttons, side-stripe notices, and nested cards. Docs require primary light workspace, OKLCH tokens, system sans, restrained Prism accents, reusable controls, no side-stripe notices, and no ad hoc styling.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Reuse `app/page.tsx` as the shell/status composition owner. Derive overview values from existing props already loaded there: Slack status, `tokenProfiles.length`, active/non-revoked token statuses from `TokenProfileSummary`, and `activity.length`.
  - Reuse `SlackStatusPanel` for state-specific Slack link details, but it may accept richer layout/class props or be wrapped by a shell overview component. Do not create a second status resolver.
  - Reuse existing CSS import path (`app/layout.tsx` -> `app/globals.css`) for design tokens. CSS custom properties in `:root` are the correct substrate for OKLCH values and future components.
  - Add local website presentation primitives under `app/` (recommended `app/ui.tsx` or `app/components/*.tsx`) for Button, Panel/Card, Badge/StatusBadge, Notice, Field wrappers, and layout sections. These should output ordinary JSX/classes and preserve semantic elements/links/forms.
  - Keep API calls in `TokenProfilesPanel` pointed at existing `/v1/prism/token-profiles*` routes; no new store/global state is needed for #17/#18.
  - Use existing tests with `renderToStaticMarkup`; add component tests for overview copy/status states and no-secret rendering rather than snapshotting class names.
- Relevant docs or library capabilities:
  - Next.js App Router supports global CSS from `app/layout.tsx`, server components for `app/page.tsx`, and client components for isolated interactivity.
  - Modern CSS handled by Next/Lightning CSS supports CSS custom properties and OKLCH. This is sufficient for #17/#18 tokens without a Tailwind dependency.
  - shadcn is a generated-component convention, not an app runtime requirement. Its useful conventions here are local primitives, variant props, accessible states, and token-driven classes; these can be implemented locally.
- Existing examples in this codebase:
  - `app/date-format.ts` is the pattern for a small presentation helper shared across panels.
  - Existing route handlers are thin wrappers over server modules; keep the redesign out of route/service layers.
  - Dependency guard tests already protect against inappropriate substrate dependencies such as Supabase/Auth/PostGREST and server-only boundary leaks.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not add a second frontend app, Pages Router, client-only dashboard, data loader, status API fetch, auth/session layer, token-profile store, activity store, or date formatter.
  - Do not duplicate `getSlackLinkStatus`, `listTokenProfiles`, `createPostgresActivityAuditStore`, `toActivityAuditSummary`, or `app/date-format.ts` in UI code.
  - Do not replace `TokenProfilesPanel` or `ActivityAuditPanel` workflow semantics while doing #17/#18. Styling their outer surfaces is acceptable; changing profile creation UX belongs to #19 unless minimally required by shared primitives.
  - Do not introduce generic shadcn/Tailwind defaults that override Prism tokens, typography, or copy.
  - Do not route OAuth through a new button handler; keep the anchor href to `/v1/slack/oauth/start`.
- Shortcuts or parallel paths to avoid:
  - Avoid inline `style={{ ... }}` and one-off hardcoded color classes; use tokens/classes/primitives.
  - Avoid CSS tied only to color for state. Status components must include text and, where useful, icon/shape labels.
  - Avoid changing server modules to compute purely visual summary strings. Keep formatting/presentation in `app/`.
  - Avoid Tailwind installation as a cosmetic shortcut for this tranche unless the implementer commits to full config, purge/content setup, package-lock changes, and non-generic token mapping. A half-integrated utility layer would create a parallel styling path.
  - Avoid hiding hydration issues with `suppressHydrationWarning` or client-only rendering.
- Invariants:
  - No Slack credential, developer token except immediate copy-once success state, token hash, message text, search query, file content, or secret material may appear in shell/status/profile/audit rendered metadata or tests.
  - Slack status states remain semantically distinct: not linked, setup required, linked healthy, linked reauth required.
  - Reauth-required preserves Token profile management but explains call failure/reconnect risk.
  - Date/time text remains deterministic UTC via `app/date-format.ts`.
  - #17/#18 must not begin #19 Token profile workflow redesign or #20 audit redesign except for minimal shared wrappers/classes.

## Integration plan

- Insert the change at:
  - **Design-system substrate (#17):** update `app/globals.css` to define Prism tokens in `:root` using DESIGN.md's OKLCH direction: background, surfaces, text, muted text, border, primary/focus, success/warning/danger/info, radii, shadows, spacing rhythm, and typography. Preserve global reset and add visible `:focus-visible`, reduced-motion, form-control, and responsive layout rules.
  - **Local primitives (#17):** add local app-level UI primitives (for example `app/ui.tsx` plus typed variants) for Button/LinkButton, Panel, Badge/StatusBadge, Notice, Field/Select wrappers, and SummaryMetric. These should map to CSS classes in `globals.css` and support primary/secondary/quiet/destructive/loading/disabled states where current controls need them.
  - **Shell/status overview (#18):** refactor `app/page.tsx` to render a product header/shell and summary band before the existing panels. The shell should answer: Slack linked/healthy state, custody boundary, active Token profile count, and recent metadata activity presence. Use current loaded `status`, `tokenProfiles`, and `activity`; do not add new fetches.
  - **Slack status detail (#18):** adapt `app/slack-status-panel.tsx` to use local primitives and clearer status badges/copy while preserving all existing state branches and OAuth hrefs.
  - **Minimal panel integration surface (#17/#18):** update `TokenProfilesPanel` and `ActivityAuditPanel` only enough to consume shared primitives/classes and avoid visual mismatch. Do not redesign Token profile creation flow (#19) or audit row density (#20) in this tranche.
  - **Tests:** extend existing panel tests and add a page/shell-oriented renderable helper if needed. Prefer extracting pure overview helpers from `app/page.tsx` when server-only cookie/database imports make direct page rendering awkward.
- Why this is the correct integration point:
  - The change is presentation/shell architecture, and the existing App Router website already owns presentation composition. Existing server modules already provide the data needed for overview metrics.
  - CSS custom properties plus local primitives satisfy PRODUCT/DESIGN's maintainable, shadcn-style substrate without introducing a new build/styling stack.
  - Keeping the changes in `app/` preserves all data custody, token profile, audit, and OAuth boundaries.
- Alternatives considered and rejected:
  - **Install Tailwind/shadcn for #17/#18:** rejected for this tranche. The repo has no Tailwind config or shadcn setup; installing would add multiple dependencies/config files and likely require broad class rewrites before delivering shell value. DESIGN.md says Tailwind/shadcn-style components are acceptable, not mandatory. Local primitives over CSS tokens are lower risk, build-safe with Next 16, and better preserve Prism-specific identity.
  - **Leave styling as global ad hoc classes only:** rejected because #17 explicitly requires a maintainable substrate and PRODUCT.md rejects ad hoc styling/inconsistent buttons.
  - **Create a new dashboard route/client app:** rejected as a parallel path around `app/page.tsx`, existing dynamic session loading, and existing panels.
  - **Start #19 guided Token profile workflow now:** rejected because #18 is independently demoable and #19 is out of scope. Only foundational primitive hooks/classes should be prepared.

## Regression checklist

- Behavior: `npm test` passes with existing route/service/component/no-secret coverage.
- Behavior: `npm run build` passes with Next.js App Router and any CSS/component changes.
- Behavior: `/` remains dynamic and session-scoped; no static caching of user status/profile/activity data.
- Behavior: Not linked shows `Connect Slack` linking to `/v1/slack/oauth/start` and no secret material.
- Behavior: Linked healthy shows Slack identity and workspace/organization scope with text status, not color alone.
- Behavior: Reauth required shows identity context and `Reconnect Slack`, preserves Token profile panel availability, and does not delete or hide profile context.
- Behavior: Setup required still explains missing OAuth/encryption configuration.
- Behavior: Token profile create/rotate/revoke/policy forms still call existing routes, show copy-once token only immediately after create/rotate, and do not persist/display token material in listings.
- Behavior: Activity audit remains metadata-only and does not surface Slack payloads, search text, file contents, or tokens.
- Behavior: Date rendering still uses deterministic UTC helper; no default-locale date formatting returns.
- Behavior: Responsive shell works as single-column mobile, stacked tablet, and workspace desktop without hover-only controls.
- Behavior: Visible focus states and text-plus-color statuses meet WCAG AA intent.

## Test plan

- Existing tests to keep green:
  - `app/slack-status-panel.test.tsx`
  - `app/token-profiles-panel.test.tsx`
  - `app/activity-audit-panel.test.tsx`
  - `app/date-format.test.ts`
  - `app/v1/prism/*` and `app/v1/slack/*` route tests
  - `src/server/token-profiles/*`, `src/server/audit/*`, `src/server/slack/*`, and dependency guard tests
- New tests to add before/with implementation:
  - Slack status render coverage for shell/status overview across not linked, linked healthy, reauth required, and setup required, asserting visible labels, OAuth hrefs, custody copy, and no secret-like strings.
  - Overview helper tests for active Token profile count and recent activity presence using existing `TokenProfileSummary` and `ActivityAuditSummary` shapes. Count only non-revoked/non-expired active tokens if exposing "active" specifically; otherwise label as total profiles.
  - Component tests for reusable primitives where behavior matters: link/button disabled/loading semantics if used, status badges include text, notices have headings/copy, focusable controls remain semantic buttons/anchors/inputs/selects.
  - A static/test guard if practical that website components do not introduce inline style attributes or default-locale date formatting.
  - Update existing no-secret assertions when shell copy adds new visible metadata.
- Live proof required:
  - Start local app with `npm run dev` on port 3732 after build/test pass.
  - Use Playwright/browser QA at desktop, tablet, and mobile widths to capture the homepage for not-linked state at minimum.
  - If local mock OAuth/database is available, create a linked session and capture linked healthy/reauth-style evidence with Token profile count and activity presence.
  - Inspect browser console for hydration errors and secret-like leaks; verify `/v1/slack/oauth/start` link remains present and navigable.

## Risk assessment

- Risk: A shell refactor could accidentally make `app/page.tsx` static or move session-scoped data into client fetches, leaking/staling user state. Mitigation: keep `dynamic = "force-dynamic"` and server composition.
- Risk: Broad CSS selector changes (`article`, `p`, `h1`, `h2`) could unintentionally restyle forms/audit rows and reduce accessibility. Mitigation: move toward explicit component classes/tokens and avoid fragile element-wide styling where possible.
- Risk: Introducing Tailwind/shadcn now could create two styling systems or generic defaults. Mitigation: use local primitives/CSS tokens for #17/#18; revisit Tailwind only if a later slice justifies full migration.
- Risk: Status overview may misstate "active Token profiles" if it counts all profiles including revoked/expired/missing developer tokens. Mitigation: derive and label counts carefully from `developerToken.status` or call it "Token profiles" if status cannot be guaranteed.
- Risk: Copy changes could accidentally weaken custody/no-secret guarantees or expose request/profile identifiers in inappropriate places. Mitigation: preserve existing no-secret regex tests and metadata-only copy.
- Risk: Reusable primitives could break form submit behavior if buttons/anchors are wrapped incorrectly. Mitigation: primitives must render native `button`, `a`, `section`, `label`, `input`, and `select` semantics; add render tests.
- Risk: OKLCH contrast/focus colors may miss WCAG AA. Mitigation: verify contrast manually/tooling during live QA and adjust tokens before final review.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership is clear: #17/#18 are website presentation changes in `app/`, while server modules already provide required data and must not change.
  - Current code has no Tailwind/shadcn substrate, and Next's existing CSS pipeline is enough for OKLCH tokens/local primitives.
  - Baseline `npm test` and `npm run build` pass, giving a clear regression target.
  - Conflicts between docs and current code are visual/systemic rather than data-model conflicts, so they can be corrected without touching OAuth, token, audit, or forwarding semantics.
- Open questions:
  - Whether product wants the overview count labelled strictly "active Token profiles" or more conservatively "Token profiles" when profile token status is missing. Recommendation: compute active from known `developerToken.status === "active"` and expose total separately only if useful.
  - Whether to add a formal lint/static rule for inline styles now or rely on component tests/review. Recommendation: add a lightweight test guard only for `app/*.tsx` if it stays low-maintenance.
